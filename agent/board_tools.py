"""board_tools.py — Tool schemas + executor for the Curio voice→whiteboard harness.

This is M2 of the harness pipeline. It is deliberately decoupled from M1
(board_state.py): the ``state`` parameter everywhere is a duck-typed BoardState
(any object exposing the M1 async methods), never a direct import. This lets M1
and M2 be built and tested independently.

Tool → board action mapping:
  write_notes    → addMarkdown          (single shape, id = block id)
  make_flowchart → addFlowchart         (multi-shape: one per step + arrows; child ids = step ids)
  make_mindmap   → addMindMap           (multi-shape: center + branches; child ids = center + branch ids)
  add_image      → requestImage         (stub: shimmer placeholder; no resolveImage in v1)
  highlight      → highlightNode        (no state write needed)
  remove_block   → removeNode × N       (one removeNode per child shape id, then state.remove_block)
  clear_board    → clearBoard           (no state write; caller should state.clear() separately)
"""

from __future__ import annotations

import os
import re
import time
from typing import Any

import httpx
import sentry_sdk
from loguru import logger

# ---------------------------------------------------------------------------
# Default bridge endpoint
# ---------------------------------------------------------------------------

WHITEBOARD_SEND_URL: str = os.getenv("WHITEBOARD_SEND_URL", "http://localhost:3000/api/board/send")

# ---------------------------------------------------------------------------
# Content size caps — prevent unbounded data from landing in Redis / the bridge.
# LLM max_tokens is already 2000 tokens (~8 KB), but we cap defensively here
# in case a future caller raises that limit or tool args arrive from another path.
# ---------------------------------------------------------------------------

_MAX_CONTENT_BYTES = 64 * 1024   # 64 KB per block content / markdown field
_MAX_TITLE_CHARS   = 500         # generous but bounded block title
_MAX_LABEL_CHARS   = 500         # flowchart step / mind-map branch label
_MAX_STEPS         = 100         # max flowchart steps per call
_MAX_BRANCHES      = 100         # max mind-map branches per call
_VALID_ID = re.compile(r"^[\w\-:.]{1,128}$")


def _valid_id(value: Any, field: str = "id") -> str:
    if not isinstance(value, str) or not _VALID_ID.fullmatch(value):
        raise ValueError(f"invalid {field}")
    return value


def _clamp_str(s: str, max_chars: int, field: str = "field") -> str:
    """Truncate *s* to *max_chars* characters, logging a warning if truncated."""
    if len(s) > max_chars:
        logger.warning(
            f"board_tools: {field!r} truncated from {len(s)} to {max_chars} chars"
        )
        return s[:max_chars]
    return s

# ---------------------------------------------------------------------------
# Layout constants (simple grid packing — real geometry comes back via M4)
# ---------------------------------------------------------------------------

_BLOCK_W = 480       # assumed block width (pixels)
_BLOCK_H = 320       # assumed block height
_GAP = 40            # gap between blocks
_COL_COUNT = 3       # blocks per row before wrapping
_ORIGIN_X = 100
_ORIGIN_Y = 100
_DIR_OFFSET = {      # pixel offsets for anchor.dir hints
    "right":  (_BLOCK_W + _GAP, 0),
    "left":   (-(_BLOCK_W + _GAP), 0),
    "below":  (0, _BLOCK_H + _GAP),
    "above":  (0, -(_BLOCK_H + _GAP)),
}

# ---------------------------------------------------------------------------
# TOOL_SCHEMAS — OpenAI function-calling tool definitions (7 tools)
# ---------------------------------------------------------------------------

_ANCHOR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": "Optional relational placement hint. Never include pixel coords.",
    "properties": {
        "near": {
            "type": "string",
            "description": "Semantic id of the block to place near.",
        },
        "dir": {
            "type": "string",
            "enum": ["right", "left", "below", "above"],
            "description": "Direction relative to the 'near' block.",
        },
    },
    "required": [],
    "additionalProperties": False,
}

TOOL_SCHEMAS: list[dict[str, Any]] = [
    # ------------------------------------------------------------------
    # write_notes → addMarkdown
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "write_notes",
            "description": (
                "Add or update a prose/bullet/table Markdown block on the whiteboard. "
                "Calling with the same id updates the block in place (upsert). "
                "GFM tables and fenced code blocks are supported."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Stable semantic id chosen by the model (e.g. 'topic_photosynthesis').",
                    },
                    "topicId": {
                        "type": "string",
                        "description": (
                            "Stable id of the TOPIC thread this block belongs to. "
                            "Reuse the same topicId for every block in one topic; "
                            "mint a NEW topicId when the student moves to a new topic."
                        ),
                    },
                    "title": {
                        "type": "string",
                        "description": "Block title shown in the header.",
                    },
                    "markdown": {
                        "type": "string",
                        "description": "Full Markdown content for this block.",
                    },
                    "anchor": _ANCHOR_SCHEMA,
                },
                "required": ["id", "topicId", "title", "markdown"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # make_flowchart → addFlowchart
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "make_flowchart",
            "description": (
                "Add or update a flowchart. Each step becomes a node; edges follow "
                "the array order. Client-side ELK layout positions nodes automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Stable semantic id for this flowchart block.",
                    },
                    "topicId": {
                        "type": "string",
                        "description": (
                            "Stable id of the TOPIC thread this block belongs to. "
                            "Reuse the same topicId for every block in one topic; "
                            "mint a NEW topicId when the student moves to a new topic."
                        ),
                    },
                    "title": {
                        "type": "string",
                        "description": "Title of the flowchart.",
                    },
                    "steps": {
                        "type": "array",
                        "description": "Ordered list of flowchart steps.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Unique id for this step (scoped to this flowchart).",
                                },
                                "label": {
                                    "type": "string",
                                    "description": "Node label.",
                                },
                                "subtitle": {
                                    "type": "string",
                                    "description": "Optional subtitle / detail text.",
                                },
                            },
                            "required": ["id", "label"],
                            "additionalProperties": False,
                        },
                        "minItems": 1,
                    },
                    "anchor": _ANCHOR_SCHEMA,
                },
                "required": ["id", "topicId", "title", "steps"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # make_mindmap → addMindMap
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "make_mindmap",
            "description": (
                "Add or update a mind map. A center node radiates to branch nodes. "
                "Client-side d3-force layout is applied automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Stable semantic id for this mind map block.",
                    },
                    "topicId": {
                        "type": "string",
                        "description": (
                            "Stable id of the TOPIC thread this block belongs to. "
                            "Reuse the same topicId for every block in one topic; "
                            "mint a NEW topicId when the student moves to a new topic."
                        ),
                    },
                    "center": {
                        "type": "string",
                        "description": "Label for the center node.",
                    },
                    "branches": {
                        "type": "array",
                        "description": "Branch nodes radiating from the center.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Unique id for this branch (scoped to this mind map).",
                                },
                                "label": {
                                    "type": "string",
                                    "description": "Branch label.",
                                },
                            },
                            "required": ["id", "label"],
                            "additionalProperties": False,
                        },
                        "minItems": 1,
                    },
                    "anchor": _ANCHOR_SCHEMA,
                },
                "required": ["id", "topicId", "center", "branches"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # add_image → requestImage  (stub: no resolveImage in v1)
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "add_image",
            "description": (
                "Add an image placeholder (shimmer) for the given prompt. "
                "Image generation is stubbed in v1; the placeholder shape appears immediately."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Stable semantic id for this image block.",
                    },
                    "topicId": {
                        "type": "string",
                        "description": (
                            "Stable id of the TOPIC thread this block belongs to. "
                            "Reuse the same topicId for every block in one topic; "
                            "mint a NEW topicId when the student moves to a new topic."
                        ),
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Text description of the image to generate.",
                    },
                    "caption": {
                        "type": "string",
                        "description": "Optional caption shown below the image.",
                    },
                    "anchor": _ANCHOR_SCHEMA,
                },
                "required": ["id", "topicId", "prompt"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # highlight → highlightNode
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "highlight",
            "description": (
                "Pulse-highlight a block while referencing it verbally. "
                "Pans the camera to bring the block into view if off-screen."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Semantic id of the block to highlight.",
                    },
                },
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # remove_block → removeNode × N
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "remove_block",
            "description": (
                "Permanently delete a block and all its child shapes from the board."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Semantic id of the block to remove.",
                    },
                },
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # clear_board → clearBoard
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "clear_board",
            "description": "Remove ALL shapes from the whiteboard and reset it to blank.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False,
            },
        },
    },
]

# ---------------------------------------------------------------------------
# BridgePoster — thin HTTP wrapper around the mock-server /send endpoint
# ---------------------------------------------------------------------------


class BridgePoster:
    """Posts ``{action, payload}`` to the whiteboard bridge.

    Errors are swallowed and logged — the bridge may be down (e.g. in tests or
    during startup) and the voice pipeline must not crash.
    """

    def __init__(
        self,
        send_url: str = WHITEBOARD_SEND_URL,
        *,
        session: str = "default",
        token: str | None = None,
    ) -> None:
        self._send_url = send_url
        # session routes the command to the matching browser SSE subscriber;
        # token authenticates the write when the bridge has BOARD_API_TOKEN set.
        self._session = session
        self._token = token if token is not None else os.getenv("BOARD_API_TOKEN")
        self._client = httpx.AsyncClient(timeout=5.0)

    async def send(self, action: str, payload: dict[str, Any]) -> None:
        """Fire-and-forget POST.  Swallows all errors."""
        try:
            headers = {"x-board-api-token": self._token} if self._token else None
            resp = await self._client.post(
                self._send_url,
                json={"action": action, "payload": payload, "session": self._session},
                headers=headers,
            )
            resp.raise_for_status()
            logger.debug(f"bridge ← {action} ({resp.status_code})")
        except Exception as exc:
            logger.warning(f"BridgePoster.send({action!r}) failed (bridge may be down): {exc}")
            sentry_sdk.capture_exception(exc)

    async def aclose(self) -> None:
        await self._client.aclose()

# ---------------------------------------------------------------------------
# Placement helpers
# ---------------------------------------------------------------------------


def _occupied_bboxes(summary: list[dict[str, Any]]) -> list[dict[str, float]]:
    """Extract bbox dicts that have non-zero area from a state summary."""
    return [
        s["bbox"]
        for s in summary
        if s.get("bbox") and (s["bbox"].get("w", 0) or s["bbox"].get("h", 0))
    ]


def _overlaps(bbox: dict[str, float], others: list[dict[str, float]]) -> bool:
    """Return True if ``bbox`` overlaps any rect in ``others`` (with no gap check)."""
    x1, y1 = bbox["x"], bbox["y"]
    x2, y2 = x1 + bbox["w"], y1 + bbox["h"]
    for o in others:
        ox2 = o["x"] + o.get("w", _BLOCK_W)
        oy2 = o["y"] + o.get("h", _BLOCK_H)
        if x1 < ox2 and x2 > o["x"] and y1 < oy2 and y2 > o["y"]:
            return True
    return False


async def resolve_placement(
    state: Any,
    block_id: str,
    anchor: dict[str, Any] | None,
) -> dict[str, float]:
    """Return ``{x, y}`` for *block_id*.

    Algorithm:
    1. If the block already has a stored bbox with non-zero coords, reuse it.
    2. If ``anchor.near`` points to an existing block, offset from that block's
       position according to ``anchor.dir``.
    3. Otherwise, pick the next open slot in a simple left-to-right, top-to-bottom
       grid that doesn't overlap any existing bbox.
    """
    # -- 1. Reuse existing position --
    existing = await state.get_block(block_id)
    if existing:
        bbox = existing.get("bbox") or {}
        if bbox.get("x") or bbox.get("y"):  # non-zero coords → reuse
            return {"x": bbox["x"], "y": bbox["y"]}

    # -- 2. Anchor-relative placement --
    if anchor and anchor.get("near"):
        near_block = await state.get_block(anchor["near"])
        if near_block:
            nbbox = near_block.get("bbox") or {}
            nx = nbbox.get("x", _ORIGIN_X)
            ny = nbbox.get("y", _ORIGIN_Y)
            dx, dy = _DIR_OFFSET.get(anchor.get("dir", "right"), (_BLOCK_W + _GAP, 0))
            return {"x": nx + dx, "y": ny + dy}

    # -- 3. Grid packing: find first open slot --
    summary = await state.get_state_summary()
    bboxes = _occupied_bboxes(summary)

    col = 0
    row = 0
    while True:
        candidate = {
            "x": float(_ORIGIN_X + col * (_BLOCK_W + _GAP)),
            "y": float(_ORIGIN_Y + row * (_BLOCK_H + _GAP)),
            "w": float(_BLOCK_W),
            "h": float(_BLOCK_H),
        }
        if not _overlaps(candidate, bboxes):
            return {"x": candidate["x"], "y": candidate["y"]}
        col += 1
        if col >= _COL_COUNT:
            col = 0
            row += 1

# ---------------------------------------------------------------------------
# Main executor
# ---------------------------------------------------------------------------


async def execute_tool_call(
    tool_call: dict[str, Any],
    *,
    state: Any,          # duck-typed BoardState; never imported directly
    bridge: BridgePoster,
    active_topic: str,
    anchor_pos: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Translate one tool_call dict into board action(s) + state update.

    ``tool_call`` follows the OpenAI format::

        {
            "id": "call_abc",
            "type": "function",
            "function": {"name": "...", "arguments": {...}}
        }

    ``arguments`` may be a JSON string or already-parsed dict (we handle both).

    Returns a result dict ``{tool: ..., action: ..., ok: bool}`` for logging.
    """
    import json as _json

    try:
        fn = tool_call.get("function", {})
        tool_name: str = fn.get("name", "")
        raw_args = fn.get("arguments", {})
        args: dict[str, Any] = (
            _json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
        )
        if not isinstance(args, dict):
            raise ValueError("tool arguments must be an object")

        # Prefer the topicId the model explicitly supplied in the tool args; fall
        # back to the harness-injected active_topic so legacy callers still work.
        effective_topic: str = _valid_id(args.get("topicId") or active_topic, "topicId")

        logger.debug(f"execute_tool_call: tool={tool_name!r} topic={effective_topic!r} args={args}")
        result = await _dispatch(
            tool_name, args,
            state=state,
            bridge=bridge,
            active_topic=effective_topic,
        )
        return {"tool": tool_name, "ok": True, **result}
    except Exception as exc:
        logger.error(f"execute_tool_call({tool_name!r}) error: {exc}")
        sentry_sdk.capture_exception(exc)
        return {"tool": tool_name, "ok": False, "error": str(exc)}


async def _dispatch(
    tool_name: str,
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    """Route to the per-tool handler.  Raises on unknown tool (caller swallows)."""

    if tool_name == "write_notes":
        return await _write_notes(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "make_flowchart":
        return await _make_flowchart(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "make_mindmap":
        return await _make_mindmap(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "add_image":
        return await _add_image(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "highlight":
        return await _highlight(args, bridge=bridge)
    elif tool_name == "remove_block":
        return await _remove_block(args, state=state, bridge=bridge)
    elif tool_name == "clear_board":
        return await _clear_board(state=state, bridge=bridge)
    else:
        raise ValueError(f"Unknown tool: {tool_name!r}")


# ---------------------------------------------------------------------------
# Per-tool handlers
# ---------------------------------------------------------------------------


async def _write_notes(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    block_id: str = _valid_id(args["id"])
    title: str = _clamp_str(args.get("title", ""), _MAX_TITLE_CHARS, "title")
    markdown: str = _clamp_str(args.get("markdown", ""), _MAX_CONTENT_BYTES, "markdown")
    anchor: dict[str, Any] | None = args.get("anchor")

    pos = await resolve_placement(state, block_id, anchor)

    await bridge.send("addMarkdown", {
        "id": block_id,
        "markdown": markdown,
        "position": pos,
    })

    await state.upsert_block({
        "id": block_id,
        "topicId": active_topic,
        "type": "notes",
        "title": title,
        "content": markdown,
        "bbox": {"x": pos["x"], "y": pos["y"], "w": _BLOCK_W, "h": _BLOCK_H},
        "shapeIds": [block_id],  # single shape: the markdown-doc shape
        "updatedAt": time.time(),
    })

    return {"action": "addMarkdown", "id": block_id}


async def _make_flowchart(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    block_id: str = _valid_id(args["id"])
    title: str = _clamp_str(args.get("title", ""), _MAX_TITLE_CHARS, "title")
    # Cap step count and per-step label lengths to bound Redis write size.
    raw_steps: list[dict[str, Any]] = args.get("steps", [])
    if len(raw_steps) > _MAX_STEPS:
        logger.warning(f"board_tools: flowchart steps truncated from {len(raw_steps)} to {_MAX_STEPS}")
        raw_steps = raw_steps[:_MAX_STEPS]
    steps: list[dict[str, Any]] = [
        {
            **s,
            "id": _valid_id(s.get("id"), "step.id"),
            "label": _clamp_str(s.get("label", ""), _MAX_LABEL_CHARS, "step.label"),
        }
        for s in raw_steps
    ]
    anchor: dict[str, Any] | None = args.get("anchor")

    pos = await resolve_placement(state, block_id, anchor)

    # addFlowchart payload: steps array is forwarded as-is; the client keys
    # each shape by the step id inside the idMap.
    await bridge.send("addFlowchart", {
        "id": block_id,
        "steps": steps,
        "position": pos,
    })

    # Track every step id as a child shape so remove_block can delete them.
    # Convention: the addFlowchart action keys shapes by step["id"] in the idMap.
    shape_ids = [step["id"] for step in steps]

    await state.upsert_block({
        "id": block_id,
        "topicId": active_topic,
        "type": "flowchart",
        "title": title,
        "content": str([s.get("label") for s in steps]),
        "bbox": {"x": pos["x"], "y": pos["y"], "w": _BLOCK_W, "h": _BLOCK_H},
        "shapeIds": shape_ids,
        "updatedAt": time.time(),
    })

    return {"action": "addFlowchart", "id": block_id, "shapeIds": shape_ids}


async def _make_mindmap(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    block_id: str = _valid_id(args["id"])
    center_label: str = _clamp_str(args.get("center", ""), _MAX_LABEL_CHARS, "center")
    # Cap branch count and per-branch label lengths to bound Redis write size.
    raw_branches: list[dict[str, Any]] = args.get("branches", [])
    if len(raw_branches) > _MAX_BRANCHES:
        logger.warning(f"board_tools: mindmap branches truncated from {len(raw_branches)} to {_MAX_BRANCHES}")
        raw_branches = raw_branches[:_MAX_BRANCHES]
    branches: list[dict[str, Any]] = [
        {
            **b,
            "id": _valid_id(b.get("id"), "branch.id"),
            "label": _clamp_str(b.get("label", ""), _MAX_LABEL_CHARS, "branch.label"),
        }
        for b in raw_branches
    ]
    anchor: dict[str, Any] | None = args.get("anchor")

    pos = await resolve_placement(state, block_id, anchor)

    # addMindMap payload: center label + branches array forwarded as-is.
    await bridge.send("addMindMap", {
        "id": block_id,
        "centerLabel": center_label,
        "branches": branches,
        "position": pos,
    })

    # Track center shape + all branch shapes.
    # Convention: addMindMap keys the center shape as block_id + "__center"
    # and each branch by branch["id"] in the idMap.
    center_shape_id = f"{block_id}__center"
    branch_shape_ids = [branch["id"] for branch in branches]
    shape_ids = [center_shape_id] + branch_shape_ids

    await state.upsert_block({
        "id": block_id,
        "topicId": active_topic,
        "type": "mindmap",
        "title": center_label,
        "content": str([b.get("label") for b in branches]),
        "bbox": {"x": pos["x"], "y": pos["y"], "w": _BLOCK_W, "h": _BLOCK_H},
        "shapeIds": shape_ids,
        "updatedAt": time.time(),
    })

    return {"action": "addMindMap", "id": block_id, "shapeIds": shape_ids}


async def _add_image(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    block_id: str = _valid_id(args["id"])
    prompt: str = _clamp_str(args.get("prompt", ""), _MAX_TITLE_CHARS, "prompt")
    caption_raw: str | None = args.get("caption")
    caption: str | None = _clamp_str(caption_raw, _MAX_TITLE_CHARS, "caption") if caption_raw else None
    anchor: dict[str, Any] | None = args.get("anchor")

    pos = await resolve_placement(state, block_id, anchor)

    # v1 stub: send requestImage only; real resolveImage wired later.
    await bridge.send("requestImage", {
        "id": block_id,
        "prompt": prompt,
        "position": pos,
    })

    content = f"{prompt}" + (f"\n{caption}" if caption else "")
    await state.upsert_block({
        "id": block_id,
        "topicId": active_topic,
        "type": "image",
        "title": prompt[:80],
        "content": content,
        "bbox": {"x": pos["x"], "y": pos["y"], "w": _BLOCK_W, "h": _BLOCK_H},
        "shapeIds": [block_id],  # one image-node shape
        "updatedAt": time.time(),
    })

    return {"action": "requestImage", "id": block_id}


async def _highlight(
    args: dict[str, Any],
    *,
    bridge: BridgePoster,
) -> dict[str, Any]:
    block_id: str = _valid_id(args["id"])
    # highlightNode targets the block id; no state write needed.
    await bridge.send("highlightNode", {"id": block_id})
    return {"action": "highlightNode", "id": block_id}


async def _remove_block(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
) -> dict[str, Any]:
    block_id: str = _valid_id(args["id"])

    # Look up child shape ids so we can remove each shape individually.
    existing = await state.get_block(block_id)
    shape_ids: list[str] = []
    if existing:
        shape_ids = existing.get("shapeIds") or []

    if shape_ids:
        for sid in shape_ids:
            await bridge.send("removeNode", {"id": sid})
    else:
        # Fallback: try removing by the block id itself (e.g. notes / image blocks).
        await bridge.send("removeNode", {"id": block_id})

    await state.remove_block(block_id)
    return {"action": "removeNode", "id": block_id, "removedShapeIds": shape_ids}


async def _clear_board(
    *,
    state: Any,
    bridge: BridgePoster,
) -> dict[str, Any]:
    await bridge.send("clearBoard", {})
    clear = getattr(state, "clear", None)
    if clear is not None:
        await clear()
    return {"action": "clearBoard"}

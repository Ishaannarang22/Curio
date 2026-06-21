"""board_tools.py — Tool schemas + executor for the Curio voice→whiteboard harness.

This is M2 of the harness pipeline. It is deliberately decoupled from M1
(board_state.py): the ``state`` parameter everywhere is a duck-typed BoardState
(any object exposing the M1 async methods), never a direct import. This lets M1
and M2 be built and tested independently.

Tool → board action mapping (15-tool contract):
  write_notes      → addMarkdown          (single shape, id = block id)
  append_notes     → appendMarkdown       (append to existing markdown-doc shape)
  write_explanation→ addExplanation       (typewriter card)
  append_explanation→appendToExplanation  (append to existing explanation card)
  add_sticky       → addNote              (sticky note, addressable by id)
  make_flowchart   → addFlowchart         (multi-shape: one per step + arrows; child ids = step ids)
  make_mindmap     → addMindMap           (multi-shape: center + branches; child ids = center + branch ids)
  add_node         → addMindMapNode / addFlowNode  (kind-dispatch)
  connect_nodes    → connectNodes         (bound arrow between two existing nodes)
  update_node      → updateNode           (relabel any node)
  move_block       → moveShape            (animated reposition)
  add_image        → requestImage         (stub: shimmer placeholder; no resolveImage in v1)
  highlight        → highlightNode        (no state write needed)
  remove_block     → removeNode × N       (one removeNode per child shape id, then state.remove_block)
  clear_board      → clearBoard           (no state write; caller should state.clear() separately)
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

_BLOCK_W = 480       # default/fallback block width (pixels)
_BLOCK_H = 320       # default/fallback block height
_GAP = 40            # gap reserved between blocks
_COL_COUNT = 3       # blocks per row before wrapping
_ORIGIN_X = 100
_ORIGIN_Y = 100
_DIR_OFFSET = {      # pixel offsets for anchor.dir hints
    "right":  (_BLOCK_W + _GAP, 0),
    "left":   (-(_BLOCK_W + _GAP), 0),
    "below":  (0, _BLOCK_H + _GAP),
    "above":  (0, -(_BLOCK_H + _GAP)),
}

# Lattice the packer scans for a free slot. Fine enough to fill gaps between
# variably-sized artifacts, coarse enough to stay cheap.
_PLACE_STEP = 200
_PLACE_MAX_COLS = 8
_PLACE_MAX_ROWS = 80


# ---------------------------------------------------------------------------
# Size estimation — reserve a realistic bbox BEFORE the board lays a shape out.
# The board's force/ELK layout only reports its true extent afterward, but the
# packer needs a size up front to avoid dropping two artifacts in one spot
# (the chicken-and-egg). Estimates are deliberately generous (>= real footprint)
# so non-overlap is guaranteed; they self-correct only cosmetically if a later
# geometry write-back lands.
# ---------------------------------------------------------------------------


def estimate_size(tool_name: str, args: dict[str, Any]) -> dict[str, float]:
    """Return a generous ``{w, h}`` footprint estimate for a create tool's args."""
    if tool_name == "make_flowchart":
        n = max(1, len(args.get("steps") or []))
        return {"w": 320.0, "h": min(2000.0, n * 150.0 + 60.0)}
    if tool_name == "make_mindmap":
        n = max(1, len(args.get("branches") or []))
        d = min(1600.0, 420.0 + n * 60.0)
        return {"w": d, "h": d}
    if tool_name == "make_diagram":
        n = max(1, len(args.get("nodes") or []))
        d = min(1800.0, 460.0 + n * 70.0)
        return {"w": d, "h": d}
    if tool_name in ("write_notes", "append_notes"):
        text = str(args.get("markdown", ""))
        lines = sum(max(1, len(ln) // 60 + 1) for ln in (text.splitlines() or [""]))
        return {"w": 480.0, "h": min(1200.0, max(160.0, lines * 24.0 + 60.0))}
    return {"w": float(_BLOCK_W), "h": float(_BLOCK_H)}


# Formats whose board-side layout is anchored at the CENTRE of the shape
# (radial/force) rather than its top-left. For these the handler converts the
# packer's top-left slot to a centre before sending `position`.
_CENTER_ANCHORED: frozenset[str] = frozenset({"make_mindmap", "make_diagram"})

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
    # make_diagram → addDiagram
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "make_diagram",
            "description": (
                "Add or update a relationship diagram: a free-form graph of nodes "
                "connected by (optionally labelled) edges. Use when the RELATIONSHIPS "
                "between things are the point — not a linear process (use make_flowchart) "
                "and not one centre radiating outward (use make_mindmap). Client-side "
                "force layout positions the nodes automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Stable semantic id for this diagram block.",
                    },
                    "topicId": {
                        "type": "string",
                        "description": "Stable id of the TOPIC thread this block belongs to.",
                    },
                    "title": {
                        "type": "string",
                        "description": "Title of the diagram.",
                    },
                    "nodes": {
                        "type": "array",
                        "description": "The entities in the diagram.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Unique id for this node (scoped to this diagram).",
                                },
                                "label": {
                                    "type": "string",
                                    "description": "Node label.",
                                },
                            },
                            "required": ["id", "label"],
                            "additionalProperties": False,
                        },
                        "minItems": 1,
                    },
                    "edges": {
                        "type": "array",
                        "description": "Relationships between nodes (directed; fromId → toId).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "fromId": {"type": "string", "description": "Source node id."},
                                "toId": {"type": "string", "description": "Target node id."},
                                "label": {
                                    "type": "string",
                                    "description": "Optional label shown on the edge.",
                                },
                            },
                            "required": ["fromId", "toId"],
                            "additionalProperties": False,
                        },
                    },
                    "anchor": _ANCHOR_SCHEMA,
                },
                "required": ["id", "topicId", "title", "nodes", "edges"],
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
    # ------------------------------------------------------------------
    # append_notes → appendMarkdown  (new)
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "append_notes",
            "description": (
                "Append a section to an existing notes block without resending its whole body. "
                "Use to grow a topic's notes as the speaker keeps talking. "
                "id must reference a write_notes block."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Id of an existing write_notes block.",
                    },
                    "markdown": {
                        "type": "string",
                        "description": "Markdown to append below existing content.",
                    },
                },
                "required": ["id", "markdown"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # write_explanation → addExplanation  (new)
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "write_explanation",
            "description": (
                "Create or update an explanation card that reveals its text with a typewriter animation. "
                "Good for a focused, spoken-aloud definition or aside. "
                "Reuse an existing id to replace its text."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Stable semantic id, e.g. 'explain_osmosis'.",
                    },
                    "text": {
                        "type": "string",
                        "description": "Full text to reveal.",
                    },
                    "anchor": _ANCHOR_SCHEMA,
                    "w": {
                        "type": "number",
                        "description": "Optional width (default 300).",
                    },
                    "h": {
                        "type": "number",
                        "description": "Optional height (default 180).",
                    },
                },
                "required": ["id", "text"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # append_explanation → appendToExplanation  (new)
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "append_explanation",
            "description": (
                "Append more text to an existing explanation card; "
                "the new text animates in below the current text."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Id of an existing write_explanation card.",
                    },
                    "moreText": {
                        "type": "string",
                        "description": "Text to append and animate in.",
                    },
                },
                "required": ["id", "moreText"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # add_sticky → addNote  (new)
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "add_sticky",
            "description": "Place a short sticky note for a quick callout, reminder, or label.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Stable semantic id, e.g. 'note_remember_atp'.",
                    },
                    "text": {
                        "type": "string",
                        "description": "Short note text.",
                    },
                    "color": {
                        "type": "string",
                        "description": "Optional tldraw note color (default 'yellow').",
                    },
                    "anchor": _ANCHOR_SCHEMA,
                },
                "required": ["id", "text"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # add_node → addMindMapNode / addFlowNode  (new)
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "add_node",
            "description": (
                "Create or update a SINGLE graph node and place it precisely. "
                "kind 'mindMap' => a mind-map node (omit parentId for the center/home node; "
                "set parentId to auto-draw an edge from the parent). "
                "kind 'flow' => a flowchart box. "
                "Pass x/y (absolute page coords) for exact placement, or omit to let the harness place it. "
                "Reuse an id to relabel/resize in place."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Stable semantic id, e.g. 'map_home' or 'flow_step1'.",
                    },
                    "label": {
                        "type": "string",
                        "description": "Node label.",
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["mindMap", "flow"],
                        "description": "Which node shape to create.",
                    },
                    "x": {
                        "type": "number",
                        "description": "Optional absolute page x (top-left). Omit to auto-place.",
                    },
                    "y": {
                        "type": "number",
                        "description": "Optional absolute page y (top-left). Omit to auto-place.",
                    },
                    "parentId": {
                        "type": "string",
                        "description": "Optional; if set, draws an edge from this parent to the new node (mind-map use).",
                    },
                    "subtitle": {
                        "type": "string",
                        "description": "Optional secondary line (flow nodes).",
                    },
                    "w": {
                        "type": "number",
                        "description": "Optional width (defaults: mindMap 140, flow 180).",
                    },
                    "h": {
                        "type": "number",
                        "description": "Optional height (defaults: mindMap 44, flow 60/80).",
                    },
                },
                "required": ["id", "label", "kind"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # connect_nodes → connectNodes  (new)
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "connect_nodes",
            "description": (
                "Draw a bound arrow between two existing nodes "
                "(from add_node, make_flowchart, or make_mindmap). "
                "The arrow re-binds as nodes move."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "fromId": {
                        "type": "string",
                        "description": "Source node id.",
                    },
                    "toId": {
                        "type": "string",
                        "description": "Target node id.",
                    },
                    "label": {
                        "type": "string",
                        "description": "Optional edge label.",
                    },
                },
                "required": ["fromId", "toId"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # update_node → updateNode  (new — listed as "base" but missing from original 7)
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "update_node",
            "description": "Relabel an existing node in place by id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Id of an existing node.",
                    },
                    "newLabel": {
                        "type": "string",
                        "description": "New label text.",
                    },
                },
                "required": ["id", "newLabel"],
                "additionalProperties": False,
            },
        },
    },
    # ------------------------------------------------------------------
    # move_block → moveShape  (new)
    # ------------------------------------------------------------------
    {
        "type": "function",
        "function": {
            "name": "move_block",
            "description": (
                "Reposition any existing block (node, notes, image, sticky, explanation) "
                "to absolute page coordinates, animated. "
                "Use to re-arrange the board or open space for a new block."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Id of an existing block.",
                    },
                    "x": {
                        "type": "number",
                        "description": "Absolute page x (top-left).",
                    },
                    "y": {
                        "type": "number",
                        "description": "Absolute page y (top-left).",
                    },
                },
                "required": ["id", "x", "y"],
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
    size: dict[str, float] | None = None,
) -> dict[str, float]:
    """Return the top-left ``{x, y}`` to place *block_id* at.

    ``size`` is the artifact's estimated ``{w, h}`` footprint (see ``estimate_size``);
    the packer reserves that much room so a tall flowchart or wide mind map never
    lands on top of a neighbour. Defaults to the legacy fixed block size.

    Algorithm:
    1. If the block already has a stored bbox with non-zero coords, reuse it.
    2. If ``anchor.near`` points to an existing block, offset from it by ``anchor.dir``.
    3. Otherwise scan a lattice for the first slot whose ``size`` rect (inflated by
       a gap) overlaps nothing on the board.
    """
    w = float((size or {}).get("w", _BLOCK_W))
    h = float((size or {}).get("h", _BLOCK_H))

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

    # -- 3. Lattice packing: first slot whose footprint (plus a gap) is clear --
    summary = await state.get_state_summary()
    bboxes = _occupied_bboxes(summary)

    for row in range(_PLACE_MAX_ROWS):
        for col in range(_PLACE_MAX_COLS):
            x = float(_ORIGIN_X + col * _PLACE_STEP)
            y = float(_ORIGIN_Y + row * _PLACE_STEP)
            # Inflate by _GAP so artifacts keep breathing room between them.
            candidate = {"x": x, "y": y, "w": w + _GAP, "h": h + _GAP}
            if not _overlaps(candidate, bboxes):
                return {"x": x, "y": y}

    # Board is densely packed — stack below everything as a last resort.
    max_bottom = max(
        (b["y"] + b.get("h", _BLOCK_H) for b in bboxes),
        default=float(_ORIGIN_Y),
    )
    return {"x": float(_ORIGIN_X), "y": float(max_bottom + _GAP)}

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
    elif tool_name == "append_notes":
        return await _append_notes(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "write_explanation":
        return await _write_explanation(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "append_explanation":
        return await _append_explanation(args, bridge=bridge)
    elif tool_name == "add_sticky":
        return await _add_sticky(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "make_flowchart":
        return await _make_flowchart(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "make_mindmap":
        return await _make_mindmap(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "make_diagram":
        return await _make_diagram(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "add_node":
        return await _add_node(args, state=state, bridge=bridge, active_topic=active_topic)
    elif tool_name == "connect_nodes":
        return await _connect_nodes(args, bridge=bridge)
    elif tool_name == "update_node":
        return await _update_node(args, state=state, bridge=bridge)
    elif tool_name == "move_block":
        return await _move_block(args, state=state, bridge=bridge)
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

    size = estimate_size("write_notes", {"markdown": markdown})
    pos = await resolve_placement(state, block_id, anchor, size=size)

    await bridge.send("addMarkdown", {
        "id": block_id,
        "markdown": markdown,
        "position": pos,  # markdown-doc anchors at its top-left
    })

    await state.upsert_block({
        "id": block_id,
        "topicId": active_topic,
        "type": "notes",
        "title": title,
        "content": markdown,
        "bbox": {"x": pos["x"], "y": pos["y"], "w": size["w"], "h": size["h"]},
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

    size = estimate_size("make_flowchart", {"steps": steps})
    pos = await resolve_placement(state, block_id, anchor, size=size)

    # addFlowchart payload: steps array is forwarded as-is; the client keys
    # each shape by the step id inside the idMap. ELK anchors at the top-left.
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
        "bbox": {"x": pos["x"], "y": pos["y"], "w": size["w"], "h": size["h"]},
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

    size = estimate_size("make_mindmap", {"branches": branches})
    pos = await resolve_placement(state, block_id, anchor, size=size)
    # addMindMap anchors at the CENTRE of the map → convert the top-left slot.
    center = {"x": pos["x"] + size["w"] / 2, "y": pos["y"] + size["h"] / 2}

    # addMindMap payload: center label + branches array forwarded as-is.
    await bridge.send("addMindMap", {
        "id": block_id,
        "centerLabel": center_label,
        "branches": branches,
        "position": center,
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
        "bbox": {"x": pos["x"], "y": pos["y"], "w": size["w"], "h": size["h"]},
        "shapeIds": shape_ids,
        "updatedAt": time.time(),
    })

    return {"action": "addMindMap", "id": block_id, "shapeIds": shape_ids}


async def _make_diagram(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    block_id: str = _valid_id(args["id"])
    title: str = _clamp_str(args.get("title", ""), _MAX_TITLE_CHARS, "title")

    raw_nodes: list[dict[str, Any]] = args.get("nodes", [])
    if len(raw_nodes) > _MAX_BRANCHES:
        logger.warning(f"board_tools: diagram nodes truncated from {len(raw_nodes)} to {_MAX_BRANCHES}")
        raw_nodes = raw_nodes[:_MAX_BRANCHES]
    nodes: list[dict[str, Any]] = [
        {
            **n,
            "id": _valid_id(n.get("id"), "node.id"),
            "label": _clamp_str(n.get("label", ""), _MAX_LABEL_CHARS, "node.label"),
        }
        for n in raw_nodes
    ]
    node_ids = {n["id"] for n in nodes}

    raw_edges: list[dict[str, Any]] = args.get("edges", [])
    if len(raw_edges) > _MAX_BRANCHES:
        logger.warning(f"board_tools: diagram edges truncated from {len(raw_edges)} to {_MAX_BRANCHES}")
        raw_edges = raw_edges[:_MAX_BRANCHES]
    edges: list[dict[str, Any]] = []
    for e in raw_edges:
        from_id = _valid_id(e.get("fromId"), "edge.fromId")
        to_id = _valid_id(e.get("toId"), "edge.toId")
        # Drop edges that reference a node we didn't create — a dangling arrow
        # would silently no-op on the board anyway.
        if from_id not in node_ids or to_id not in node_ids:
            logger.warning(f"board_tools: dropping diagram edge {from_id!r}→{to_id!r} (unknown node)")
            continue
        edge: dict[str, Any] = {"fromId": from_id, "toId": to_id}
        if e.get("label"):
            edge["label"] = _clamp_str(e["label"], _MAX_LABEL_CHARS, "edge.label")
        edges.append(edge)

    anchor: dict[str, Any] | None = args.get("anchor")

    size = estimate_size("make_diagram", {"nodes": nodes})
    pos = await resolve_placement(state, block_id, anchor, size=size)
    # addDiagram anchors at the CENTRE (force layout) → convert the top-left slot.
    center = {"x": pos["x"] + size["w"] / 2, "y": pos["y"] + size["h"] / 2}

    await bridge.send("addDiagram", {
        "id": block_id,
        "nodes": nodes,
        "edges": edges,
        "position": center,
    })

    shape_ids = [n["id"] for n in nodes]

    await state.upsert_block({
        "id": block_id,
        "topicId": active_topic,
        "type": "diagram",
        "title": title,
        "content": str([n.get("label") for n in nodes]),
        "bbox": {"x": pos["x"], "y": pos["y"], "w": size["w"], "h": size["h"]},
        "shapeIds": shape_ids,
        "updatedAt": time.time(),
    })

    return {"action": "addDiagram", "id": block_id, "shapeIds": shape_ids}


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


# ---------------------------------------------------------------------------
# New tool handlers (8 additions for the full 15-tool contract)
# ---------------------------------------------------------------------------


async def _append_notes(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    """append_notes → appendMarkdown.  No topicId in contract; default to active_topic."""
    block_id: str = _valid_id(args["id"])
    markdown: str = _clamp_str(args.get("markdown", ""), _MAX_CONTENT_BYTES, "markdown")

    await bridge.send("appendMarkdown", {"id": block_id, "markdown": markdown})

    # Best-effort: update content field in state if block exists.
    existing = await state.get_block(block_id)
    if existing:
        old_content = existing.get("content", "")
        await state.upsert_block({
            **existing,
            "content": old_content + "\n\n" + markdown,
            "updatedAt": time.time(),
        })

    return {"action": "appendMarkdown", "id": block_id}


async def _write_explanation(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    """write_explanation → addExplanation.  w/h are optional passthrough fields."""
    block_id: str = _valid_id(args["id"])
    text: str = _clamp_str(args.get("text", ""), _MAX_CONTENT_BYTES, "text")
    anchor: dict[str, Any] | None = args.get("anchor")
    # w/h optional — pass through if provided so boardApi can use them
    w: float | None = args.get("w")
    h: float | None = args.get("h")

    pos = await resolve_placement(state, block_id, anchor)

    payload: dict[str, Any] = {"id": block_id, "text": text, "position": pos}
    if w is not None:
        payload["w"] = w
    if h is not None:
        payload["h"] = h

    await bridge.send("addExplanation", payload)

    block_w = w if w is not None else 300
    block_h = h if h is not None else 180
    await state.upsert_block({
        "id": block_id,
        "topicId": active_topic,
        "type": "explanation",
        "title": text[:80],
        "content": text,
        "bbox": {"x": pos["x"], "y": pos["y"], "w": block_w, "h": block_h},
        "shapeIds": [block_id],
        "updatedAt": time.time(),
    })

    return {"action": "addExplanation", "id": block_id}


async def _append_explanation(
    args: dict[str, Any],
    *,
    bridge: BridgePoster,
) -> dict[str, Any]:
    """append_explanation → appendToExplanation.  No state write (best-effort only)."""
    block_id: str = _valid_id(args["id"])
    more_text: str = _clamp_str(args.get("moreText", ""), _MAX_CONTENT_BYTES, "moreText")

    await bridge.send("appendToExplanation", {"id": block_id, "moreText": more_text})

    return {"action": "appendToExplanation", "id": block_id}


async def _add_sticky(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    """add_sticky → addNote.  Passes id so the board can register it in the idMap."""
    block_id: str = _valid_id(args["id"])
    text: str = _clamp_str(args.get("text", ""), _MAX_CONTENT_BYTES, "text")
    color: str | None = args.get("color")
    anchor: dict[str, Any] | None = args.get("anchor")

    pos = await resolve_placement(state, block_id, anchor)

    payload: dict[str, Any] = {"id": block_id, "text": text, "position": pos}
    if color is not None:
        payload["color"] = color

    await bridge.send("addNote", payload)

    await state.upsert_block({
        "id": block_id,
        "topicId": active_topic,
        "type": "note",
        "title": text[:80],
        "content": text,
        "bbox": {"x": pos["x"], "y": pos["y"], "w": 200, "h": 200},
        "shapeIds": [block_id],
        "updatedAt": time.time(),
    })

    return {"action": "addNote", "id": block_id}


async def _add_node(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
    active_topic: str,
) -> dict[str, Any]:
    """add_node → addMindMapNode (kind='mindMap') or addFlowNode (kind='flow').

    Explicit x/y → position:{x,y} (low-level coord path).
    Omitted x/y → resolve_placement (harness-placement path).
    """
    block_id: str = _valid_id(args["id"])
    label: str = _clamp_str(args.get("label", ""), _MAX_LABEL_CHARS, "label")
    kind: str = args.get("kind", "")
    if kind not in ("mindMap", "flow"):
        raise ValueError(f"add_node: invalid kind {kind!r}; must be 'mindMap' or 'flow'")

    # Explicit coords take priority; fall back to harness placement.
    raw_x: float | None = args.get("x")
    raw_y: float | None = args.get("y")
    if raw_x is not None and raw_y is not None:
        pos: dict[str, float] = {"x": float(raw_x), "y": float(raw_y)}
    else:
        pos = await resolve_placement(state, block_id, None)

    if kind == "mindMap":
        parent_id: str | None = args.get("parentId")
        payload: dict[str, Any] = {"id": block_id, "label": label, "position": pos}
        if parent_id is not None:
            payload["parentId"] = _valid_id(parent_id, "parentId")
        await bridge.send("addMindMapNode", payload)
        action = "addMindMapNode"
    else:  # kind == "flow"
        subtitle: str | None = args.get("subtitle")
        payload = {"id": block_id, "label": label, "position": pos}
        if subtitle is not None:
            payload["subtitle"] = _clamp_str(subtitle, _MAX_LABEL_CHARS, "subtitle")
        await bridge.send("addFlowNode", payload)
        action = "addFlowNode"

    await state.upsert_block({
        "id": block_id,
        "topicId": active_topic,
        "type": kind,
        "title": label,
        "content": label,
        "bbox": {"x": pos["x"], "y": pos["y"], "w": _BLOCK_W, "h": _BLOCK_H},
        "shapeIds": [block_id],
        "updatedAt": time.time(),
    })

    return {"action": action, "id": block_id}


async def _connect_nodes(
    args: dict[str, Any],
    *,
    bridge: BridgePoster,
) -> dict[str, Any]:
    """connect_nodes → connectNodes.  Edge only; no block record in state."""
    from_id: str = _valid_id(args["fromId"], "fromId")
    to_id: str = _valid_id(args["toId"], "toId")
    label_raw: str | None = args.get("label")
    label: str | None = _clamp_str(label_raw, _MAX_LABEL_CHARS, "label") if label_raw else None

    payload: dict[str, Any] = {"fromId": from_id, "toId": to_id}
    if label is not None:
        payload["label"] = label

    await bridge.send("connectNodes", payload)

    return {"action": "connectNodes", "fromId": from_id, "toId": to_id}


async def _update_node(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
) -> dict[str, Any]:
    """update_node → updateNode.  Best-effort title update in state."""
    block_id: str = _valid_id(args["id"])
    new_label: str = _clamp_str(args.get("newLabel", ""), _MAX_LABEL_CHARS, "newLabel")

    await bridge.send("updateNode", {"id": block_id, "newLabel": new_label})

    # Update stored title if block exists.
    existing = await state.get_block(block_id)
    if existing:
        await state.upsert_block({
            **existing,
            "title": new_label,
            "updatedAt": time.time(),
        })

    return {"action": "updateNode", "id": block_id}


async def _move_block(
    args: dict[str, Any],
    *,
    state: Any,
    bridge: BridgePoster,
) -> dict[str, Any]:
    """move_block → moveShape.  Updates bbox in state."""
    block_id: str = _valid_id(args["id"])
    x: float = float(args["x"])
    y: float = float(args["y"])

    await bridge.send("moveShape", {"id": block_id, "x": x, "y": y})

    # Update stored bbox position if block exists.
    existing = await state.get_block(block_id)
    if existing:
        old_bbox = existing.get("bbox") or {}
        await state.upsert_block({
            **existing,
            "bbox": {
                **old_bbox,
                "x": x,
                "y": y,
            },
            "updatedAt": time.time(),
        })

    return {"action": "moveShape", "id": block_id, "x": x, "y": y}

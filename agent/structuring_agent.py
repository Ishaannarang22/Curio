"""structuring_agent.py — the Structuring Agent.

Fired by a topic **seal** (the ``on_seal`` seam on ``TopicBoundaryProcessor``). It
turns a sealed node's immutable raw transcript into a structured artifact on the
board. Two stages (prd.md §2, decisions resolved in the design grill):

  1. **Router** — reads the raw and decides ``{needs_restructure, format}`` where
     ``format ∈ {flowchart, diagram, mindmap}``. If restructuring wouldn't help, it
     leaves the verbatim raw untouched (no render).
  2. **Renderer** — given the *locked* format, it is **forced** to that format's
     composite board tool and emits one call populated from the raw.

Seal kinds (from ``SealEvent.kind``):
  - ``leaf``   → one artifact at the node's block (provisional, live feedback).
  - ``parent`` → MERGE: one consolidated artifact at the parent's block, then the
    provisional child blocks (``SealEvent.descendant_ids``) are removed.

Runtime shape
=============
- **Off the hot path.** ``on_seal`` just enqueues and returns instantly, so the
  boundary classifier (which awaits it under its lock) is never blocked by an LLM
  call. A single background worker drains the queue **sequentially** — which also
  serializes every board write, acting as a de-facto single Canvas Writer until the
  real one lands.
- **Shared state.** It takes the *same* ``BoardState`` the boundary processor writes
  raw blocks into, so placement avoids overlapping un-structured raw and a render can
  replace the raw block in place (same block id = the node id).
- **Direct to bridge.** Renders via ``execute_tool_call`` / ``BridgePoster`` (no
  Canvas Writer yet). Write-before-remove ordering is always preserved.
- **Fail safe.** Every error is logged + sent to Sentry and dropped; a failed seal
  leaves the raw intact (never a regression).
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Optional

import httpx
import sentry_sdk
from loguru import logger

from board_state import InMemoryBoardState
from board_tools import TOOL_SCHEMAS, BridgePoster, execute_tool_call
from topic_tree import SealEvent

_DEFAULT_SEND_URL = "http://localhost:3000/api/board/send"

# format → composite board tool
_FORMAT_TOOL: dict[str, str] = {
    "flowchart": "make_flowchart",
    "diagram": "make_diagram",
    "mindmap": "make_mindmap",
}


# ---------------------------------------------------------------------------
# Model config — Sonnet 4.6 for both stages, env-overridable (design grill).
# ---------------------------------------------------------------------------


def _resolve_structuring_config() -> Optional[dict[str, Any]]:
    gateway_key = os.getenv("AI_GATEWAY_API_KEY")
    if gateway_key:
        return {
            "base_url": "https://ai-gateway.vercel.sh/v1",
            "api_key": gateway_key,
            "router_model": os.getenv("ROUTER_MODEL", "anthropic/claude-sonnet-4-6"),
            "render_model": os.getenv("STRUCTURING_MODEL", "anthropic/claude-sonnet-4-6"),
        }
    zai_key = os.getenv("ZAI_API_KEY")
    if zai_key:
        model = os.getenv("ZAI_MODEL", "glm-5")
        return {
            "base_url": os.getenv("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4/"),
            "api_key": zai_key,
            "router_model": os.getenv("ROUTER_MODEL") or model,
            "render_model": os.getenv("STRUCTURING_MODEL") or model,
            "extra": {"thinking": {"type": "disabled"}},
        }
    return None


# ---------------------------------------------------------------------------
# Prompts + the router tool
# ---------------------------------------------------------------------------

_ROUTER_SYSTEM = """\
You decide how to visualize a chunk of a student's spoken explanation on a study
whiteboard. You are given the raw transcript of ONE finished topic. Make TWO calls in
one: (1) would a visual structure genuinely help understand this better than the plain
text, and if so (2) which of three forms fits the CONTENT's shape best.

The three forms:
- flowchart — a sequence / process / cause→effect chain / ordered steps.
- diagram — a web of entities whose RELATIONSHIPS matter (many-to-many links), not a
  single centre and not a linear order.
- mindmap — one central concept that radiates out to sub-points (hierarchical, hub
  and spokes).

Set needs_restructure = false when the content is short, purely narrative/anecdotal,
a single idea, or already clear as prose — leave it as raw text rather than forcing a
shape. Bias toward false if no form clearly fits. Answer ONLY via the plan_structure
tool.
"""

_RENDER_SYSTEM = """\
You convert a student's raw spoken transcript of ONE topic into a {fmt} on a study
whiteboard, using the provided tool. Rules:
- Be FAITHFUL: use only what the student actually said. NEVER invent facts, steps, or
  relationships that aren't in the transcript.
- Keep node/step/branch labels short and clear (a few words). Put any extra detail in
  a subtitle where the tool supports it.
- Give every node/step/branch/edge a unique, stable, kebab-case id.
- Capture the real structure of the explanation, not every filler word.
Emit exactly one {tool} call.
"""

_SUMMARY_SYSTEM = """\
You condense a student's raw spoken transcript of ONE topic into a SHORT sticky-note
summary for a study whiteboard. Rules:
- Be FAITHFUL: only what the student actually said. NEVER invent facts.
- Keep it TIGHT enough to fit a sticky note: a one-line gist, or up to 3 very short
  bullet points (use "- " bullets). No headings, no preamble.
- Drop filler, repetition, false starts, and tangents — keep the substance.
Answer ONLY via the summarize_topic tool.
"""

_SUMMARY_TOOL: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "summarize_topic",
            "description": "Condense the topic's raw transcript into a short sticky-note summary.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "The short summary: a one-line gist or up to 3 brief '- ' bullets.",
                    },
                },
                "required": ["summary"],
                "additionalProperties": False,
            },
        },
    }
]

_ROUTER_TOOL: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "plan_structure",
            "description": "Decide whether and how to restructure the topic's raw transcript.",
            "parameters": {
                "type": "object",
                "properties": {
                    "needs_restructure": {
                        "type": "boolean",
                        "description": "True only if a flowchart/diagram/mindmap helps more than the raw text.",
                    },
                    "format": {
                        "type": "string",
                        "enum": ["flowchart", "diagram", "mindmap"],
                        "description": "Which form fits best. Required when needs_restructure is true.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "One short sentence justifying the decision.",
                    },
                },
                "required": ["needs_restructure"],
                "additionalProperties": False,
            },
        },
    }
]


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class StructuringAgent:
    """Two-stage structuring on a background queue. Use ``on_seal`` as the seam."""

    def __init__(
        self,
        *,
        session: str = "default",
        send_url: str | None = None,
        state: Any | None = None,
        bridge: Any | None = None,
        http: httpx.AsyncClient | None = None,
    ):
        self._session = session
        self._send_url = send_url or os.getenv("WHITEBOARD_SEND_URL", _DEFAULT_SEND_URL)
        self._config = _resolve_structuring_config()
        self._enabled = self._config is not None
        self._http = http or httpx.AsyncClient(timeout=60)
        self._bridge: Any = bridge or BridgePoster(self._send_url, session=session)
        # Shared with the boundary processor so placement sees raw blocks and a
        # render can replace the raw block in place. Falls back to a private store.
        self._state: Any = state if state is not None else InMemoryBoardState(session=session)

        self._queue: asyncio.Queue[SealEvent] = asyncio.Queue()
        self._worker: asyncio.Task | None = None

        if self._enabled:
            logger.info(
                f"StructuringAgent enabled: router={self._config['router_model']!r} "  # type: ignore[index]
                f"render={self._config['render_model']!r} session={session!r}"
            )
        else:
            logger.warning(
                "StructuringAgent disabled (no AI_GATEWAY_API_KEY / ZAI_API_KEY). "
                "Seals are logged; the board keeps raw per-topic blocks."
            )

    # ------------------------------------------------------------------
    # The seam — enqueue and return instantly (never blocks the hot path).
    # ------------------------------------------------------------------

    async def on_seal(self, event: SealEvent) -> None:
        if not self._enabled:
            logger.info(f"SEAL [{event.kind}] {event.label!r} ({event.node_id}) — structuring disabled")
            return
        self._ensure_worker()
        self._queue.put_nowait(event)

    def _ensure_worker(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        while True:
            event = await self._queue.get()
            try:
                await self._structure(event)
            except Exception as exc:
                logger.error(f"StructuringAgent failed on {event.node_id!r}: {exc}")
                sentry_sdk.capture_exception(exc)
            finally:
                self._queue.task_done()

    async def close(self) -> None:
        """Drain in-flight seals, then close resources."""
        try:
            if self._worker is not None and not self._worker.done():
                await asyncio.wait_for(self._queue.join(), timeout=20)
        except Exception as exc:
            logger.debug(f"StructuringAgent drain on close: {exc}")
        if self._worker is not None:
            self._worker.cancel()
        await self._http.aclose()
        close_bridge = getattr(self._bridge, "aclose", None)
        if close_bridge is not None:
            await close_bridge()

    # ------------------------------------------------------------------
    # One seal: route → render → replace
    # ------------------------------------------------------------------

    async def _structure(self, event: SealEvent) -> None:
        with sentry_sdk.start_span(op="gen_ai.invoke_agent", name="structuring") as span:
            span.set_tag("curio.agent", "structuring")
            span.set_tag("curio.topic_id", event.node_id)
            span.set_tag("curio.seal_kind", event.kind)

            if not event.raw.strip():
                logger.info(f"structuring: empty raw for {event.node_id!r}, skipping")
                return

            verdict = await self._route(event)
            span.set_tag("curio.needs_restructure", verdict.get("needs_restructure"))
            span.set_tag("curio.format", verdict.get("format"))

            if not verdict.get("needs_restructure") or not verdict.get("format"):
                logger.info(
                    f"structuring: no diagram for {event.label!r} ({event.node_id}) "
                    f"— {verdict.get('reason', 'no restructure')}; shrinking to sticky"
                )
                await self._shrink_to_sticky(event)
                return

            fmt = verdict["format"]
            await self._render_and_replace(event, fmt)

    async def _route(self, event: SealEvent) -> dict[str, Any]:
        user = (
            f"TOPIC: {event.label!r}\n"
            f"SEAL KIND: {event.kind} "
            f"({'whole subtree' if event.kind == 'parent' else 'single leaf'})\n\n"
            f"RAW TRANSCRIPT:\n{event.raw}"
        )
        messages = [
            {"role": "system", "content": _ROUTER_SYSTEM},
            {"role": "user", "content": user},
        ]
        tool_calls = await self._call_llm(
            self._config["router_model"],  # type: ignore[index]
            messages,
            _ROUTER_TOOL,
            forced_tool="plan_structure",
        )
        if not tool_calls:
            return {"needs_restructure": False, "reason": "router returned nothing"}
        args = _parse_args(tool_calls[0])
        fmt = args.get("format")
        if fmt not in _FORMAT_TOOL:
            fmt = None
        return {
            "needs_restructure": bool(args.get("needs_restructure")),
            "format": fmt,
            "reason": str(args.get("reason", "")),
        }

    async def _render_and_replace(self, event: SealEvent, fmt: str) -> None:
        tool_name = _FORMAT_TOOL[fmt]
        schema = [s for s in TOOL_SCHEMAS if s["function"]["name"] == tool_name]
        user = (
            f"TOPIC: {event.label!r}\n\n"
            f"RAW TRANSCRIPT:\n{event.raw}\n\n"
            f"Build a {fmt} that captures this. Use block id {event.node_id!r}."
        )
        messages = [
            {"role": "system", "content": _RENDER_SYSTEM.format(fmt=fmt, tool=tool_name)},
            {"role": "user", "content": user},
        ]
        tool_calls = await self._call_llm(
            self._config["render_model"],  # type: ignore[index]
            messages,
            schema,
            forced_tool=tool_name,
        )
        create_tc = next(
            (tc for tc in tool_calls if tc.get("function", {}).get("name") == tool_name),
            None,
        )
        if create_tc is None:
            logger.warning(f"structuring: renderer emitted no {tool_name} for {event.node_id!r}")
            return

        # Pin the ids ourselves so the artifact lands at the node's block (don't
        # trust the model to echo the id), enabling in-place replacement.
        args = _parse_args(create_tc)
        args["id"] = event.node_id
        args["topicId"] = event.node_id
        create_tc = {
            "id": create_tc.get("id", "call_render"),
            "type": "function",
            "function": {"name": tool_name, "arguments": args},
        }

        # 1. Write the new artifact FIRST (never a blank flash).
        result = await execute_tool_call(
            create_tc, state=self._state, bridge=self._bridge, active_topic=event.node_id
        )
        if not result.get("ok"):
            logger.warning(f"structuring: render failed for {event.node_id!r}: {result.get('error')}")
            return

        # 2. Remove the leftover raw markdown shape at this block id (board-only —
        # the block record now describes the artifact, so don't touch state).
        await self._bridge.send("removeNode", {"id": event.node_id})

        # 3. Parent MERGE: clear every provisional child block (shapes + state).
        if event.kind == "parent":
            for desc_id in event.descendant_ids:
                await execute_tool_call(
                    {"type": "function", "function": {"name": "remove_block", "arguments": {"id": desc_id}}},
                    state=self._state,
                    bridge=self._bridge,
                    active_topic=event.node_id,
                )

        logger.info(f"structuring: rendered {fmt} for {event.label!r} ({event.node_id})")

    async def _shrink_to_sticky(self, event: SealEvent) -> None:
        """No diagram needed → condense the raw into a sticky-note summary, replacing the
        verbose live-transcript markdown block in place. Keeps the content, shrunk."""
        summary = await self._summarize(event)
        if not summary:
            # Couldn't summarize — leave the raw markdown rather than blank the topic.
            logger.info(f"structuring: keep raw for {event.label!r} ({event.node_id}) — empty summary")
            return

        # Remove the verbose markdown shape FIRST. Its idMap entry is still intact (the
        # sticky below re-registers node_id); the state block stays so the sticky reuses
        # the same position (resolve_placement rule 1 = "reuse existing bbox").
        await self._bridge.send("removeNode", {"id": event.node_id})

        result = await execute_tool_call(
            {"type": "function", "function": {"name": "add_sticky", "arguments": {
                "id": event.node_id, "text": summary, "color": "yellow"}}},
            state=self._state, bridge=self._bridge, active_topic=event.node_id,
        )
        if not result.get("ok"):
            logger.warning(f"structuring: sticky failed for {event.node_id!r}: {result.get('error')}")
            return

        # Parent MERGE: a shrunk parent still consolidates — clear provisional children.
        if event.kind == "parent":
            for desc_id in event.descendant_ids:
                await execute_tool_call(
                    {"type": "function", "function": {"name": "remove_block", "arguments": {"id": desc_id}}},
                    state=self._state, bridge=self._bridge, active_topic=event.node_id,
                )

        logger.info(f"structuring: shrank {event.label!r} ({event.node_id}) into a sticky")

    async def _summarize(self, event: SealEvent) -> str:
        messages = [
            {"role": "system", "content": _SUMMARY_SYSTEM},
            {"role": "user", "content": f"TOPIC: {event.label!r}\n\nRAW TRANSCRIPT:\n{event.raw}"},
        ]
        tool_calls = await self._call_llm(
            self._config["render_model"],  # type: ignore[index]
            messages,
            _SUMMARY_TOOL,
            forced_tool="summarize_topic",
        )
        if not tool_calls:
            return ""
        return str(_parse_args(tool_calls[0]).get("summary", "")).strip()

    # ------------------------------------------------------------------
    # LLM call — injectable for tests (monkeypatch _call_llm).
    # ------------------------------------------------------------------

    async def _call_llm(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        forced_tool: str,
    ) -> list[dict[str, Any]]:
        """Call the LLM forcing ``forced_tool``. Returns tool_calls ([] on error)."""
        assert self._config is not None
        try:
            body: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "tools": tools,
                "tool_choice": {"type": "function", "function": {"name": forced_tool}},
                "temperature": 0.2,
                "max_tokens": 1500,
            }
            body.update(self._config.get("extra") or {})
            resp = await self._http.post(
                f"{self._config['base_url'].rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {self._config['api_key']}"},
                json=body,
                timeout=60,
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
            choice = data.get("choices", [{}])[0]
            usage = data.get("usage") or {}
            if usage:
                span = sentry_sdk.get_current_span()
                if span is not None:
                    span.set_data("gen_ai.usage.input_tokens", usage.get("prompt_tokens"))
                    span.set_data("gen_ai.usage.output_tokens", usage.get("completion_tokens"))
            return choice.get("message", {}).get("tool_calls") or []
        except Exception as exc:
            logger.error(f"StructuringAgent._call_llm error: {exc}")
            sentry_sdk.capture_exception(exc)
            return []


def _parse_args(tool_call: dict[str, Any]) -> dict[str, Any]:
    raw = tool_call.get("function", {}).get("arguments", {})
    try:
        args = json.loads(raw) if isinstance(raw, str) else (raw or {})
        return args if isinstance(args, dict) else {}
    except Exception:
        return {}

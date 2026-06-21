"""spawner_agent.py — the Spawner Agent (second worker).

Fired by the same topic **seal** seam as the Structuring Agent (the ``on_seal``
callback on ``TopicBoundaryProcessor``). Where the Structuring Agent reorganizes a
sealed topic's raw transcript into a *main-region* artifact, the Spawner adds
**supporting visuals in the margin** — an illustrative image of a concept the
student actually mentioned, and optionally a sticky restating a key term they used.

Design (resolved in the build grill):
  - **Faithful visuals only** — like the Structuring Agent, it NEVER invents facts.
    The image depicts only what was said; the sticky restates a term the student
    actually used. No analogies/examples/definitions the student didn't say.
  - **Fires on leaf seals, cleans on parent merge.** Leaf seals (where most content
    lives) get live margin visuals. On a ``parent`` seal the Structuring Agent MERGEs
    and removes the provisional child blocks; the Spawner mirrors that by clearing the
    margin artifacts it created for those children (``descendant_ids``), then
    re-enriches the consolidated block once. No orphaned floating images.
  - **Margin = anchored right.** Each visual is placed with the existing relational
    anchor hint ``{near: <node_id>, dir: "right"}`` so it sits beside the artifact it
    supports; the board packer guarantees non-overlap. No new region/layout code.

Runtime shape mirrors ``StructuringAgent``:
  - **Off the hot path.** ``on_seal`` just enqueues and returns instantly.
  - A single background worker drains the queue **sequentially**.
  - **Shared state** with the boundary processor / Structuring Agent so placement sees
    existing blocks and anchors resolve.
  - **Direct to bridge** via ``execute_tool_call`` / ``BridgePoster`` (no Canvas Writer
    yet). Because both workers now write concurrently to one shared ``BoardState``,
    they write *disjoint* block ids (Structuring owns ``node_id``; the Spawner owns
    ``{node_id}__img`` / ``{node_id}__term``). The real serialized Canvas Writer
    (implementation.md §1.5, still deferred) would make this strictly ordered.
  - **Fail safe.** Every error is logged + sent to Sentry and dropped; a failed seal
    never regresses the board.

NOTE: image generation is stubbed in v1 (``add_image`` → ``requestImage`` shimmer
placeholder showing the prompt); the Spawner is ready for real generation when it lands.
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
from board_tools import BridgePoster, execute_tool_call
from topic_tree import SealEvent

_DEFAULT_SEND_URL = "http://localhost:3000/api/board/send"

# Margin anchor: sit each visual to the right of the topic's main block.
_MARGIN_DIR = "right"


# ---------------------------------------------------------------------------
# Model config — mirrors structuring_agent's resolver (gateway → ZAI), with a
# SPAWNER_MODEL override. One model: the decider.
# ---------------------------------------------------------------------------


def _resolve_spawner_config() -> Optional[dict[str, Any]]:
    gateway_key = os.getenv("AI_GATEWAY_API_KEY")
    if gateway_key:
        return {
            "base_url": "https://ai-gateway.vercel.sh/v1",
            "api_key": gateway_key,
            "model": os.getenv("SPAWNER_MODEL", "anthropic/claude-sonnet-4-6"),
        }
    zai_key = os.getenv("ZAI_API_KEY")
    if zai_key:
        model = os.getenv("ZAI_MODEL", "glm-5")
        return {
            "base_url": os.getenv("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4/"),
            "api_key": zai_key,
            "model": os.getenv("SPAWNER_MODEL") or model,
            "extra": {"thinking": {"type": "disabled"}},
        }
    return None


# ---------------------------------------------------------------------------
# Prompt + the decider tool
# ---------------------------------------------------------------------------

_DECIDE_SYSTEM = """\
You add SUPPORTING VISUALS to the margin of a student's study whiteboard, beside the
main notes for ONE topic they just finished explaining. You are given that topic's raw
transcript.

You may add up to two things, and you must be FAITHFUL — use ONLY what the student
actually said. NEVER invent facts, examples, analogies, or details they did not say.

1. An IMAGE — only when the topic describes a CONCRETE, depictable thing (an object,
   structure, anatomy, apparatus, a labelled system, a geometric/spatial setup) that an
   illustration would genuinely clarify. The image_prompt must describe only what the
   student mentioned, concretely and plainly. Do NOT request an image for abstract,
   narrative, definitional, or purely verbal content — leave want_image false.
2. A KEY TERM sticky — only when the student used a specific named term/word worth
   pinning. term_gloss must restate THEIR meaning in a few words, not add new information.

Bias strongly toward doing nothing: most topics need neither. Set want_image false and
omit key_term when in doubt. Answer ONLY via the plan_support tool.
"""

_DECIDE_TOOL: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "plan_support",
            "description": "Decide which faithful margin visuals (if any) support this topic.",
            "parameters": {
                "type": "object",
                "properties": {
                    "want_image": {
                        "type": "boolean",
                        "description": "True only if a concrete, depictable concept warrants an illustration.",
                    },
                    "image_prompt": {
                        "type": "string",
                        "description": "Faithful, concrete description of the image. Required when want_image is true. Only what the student said.",
                    },
                    "image_caption": {
                        "type": "string",
                        "description": "Optional short caption for the image.",
                    },
                    "key_term": {
                        "type": "string",
                        "description": "Optional: a specific term the student actually used, worth pinning.",
                    },
                    "term_gloss": {
                        "type": "string",
                        "description": "Short restatement of the term in the student's own meaning. Required when key_term is set. No new facts.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "One short sentence justifying the decision.",
                    },
                },
                "required": ["want_image"],
                "additionalProperties": False,
            },
        },
    }
]


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class SpawnerAgent:
    """Faithful margin visuals on a background queue. Use ``on_seal`` as the seam."""

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
        self._config = _resolve_spawner_config()
        self._enabled = self._config is not None
        self._http = http or httpx.AsyncClient(timeout=60)
        self._bridge: Any = bridge or BridgePoster(self._send_url, session=session)
        # Shared with the boundary processor + Structuring Agent so anchors resolve
        # against existing blocks. Falls back to a private store.
        self._state: Any = state if state is not None else InMemoryBoardState(session=session)

        # node_id → margin block ids the Spawner created for it (for merge cleanup).
        self._spawned: dict[str, list[str]] = {}

        self._queue: asyncio.Queue[SealEvent] = asyncio.Queue()
        self._worker: asyncio.Task | None = None

        if self._enabled:
            logger.info(
                f"SpawnerAgent enabled: model={self._config['model']!r} session={session!r}"  # type: ignore[index]
            )
        else:
            logger.warning(
                "SpawnerAgent disabled (no AI_GATEWAY_API_KEY / ZAI_API_KEY). "
                "Seals are logged; no margin visuals are added."
            )

    # ------------------------------------------------------------------
    # The seam — enqueue and return instantly (never blocks the hot path).
    # ------------------------------------------------------------------

    async def on_seal(self, event: SealEvent) -> None:
        if not self._enabled:
            logger.info(f"SEAL [{event.kind}] {event.label!r} ({event.node_id}) — spawner disabled")
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
                await self._spawn(event)
            except Exception as exc:
                logger.error(f"SpawnerAgent failed on {event.node_id!r}: {exc}")
                sentry_sdk.capture_exception(exc)
            finally:
                self._queue.task_done()

    async def close(self) -> None:
        """Drain in-flight seals, then close resources."""
        try:
            if self._worker is not None and not self._worker.done():
                await asyncio.wait_for(self._queue.join(), timeout=20)
        except Exception as exc:
            logger.debug(f"SpawnerAgent drain on close: {exc}")
        if self._worker is not None:
            self._worker.cancel()
        await self._http.aclose()
        close_bridge = getattr(self._bridge, "aclose", None)
        if close_bridge is not None:
            await close_bridge()

    # ------------------------------------------------------------------
    # One seal: (parent) clean merged children → decide → emit margin visuals
    # ------------------------------------------------------------------

    async def _spawn(self, event: SealEvent) -> None:
        with sentry_sdk.start_span(op="gen_ai.invoke_agent", name="spawner") as span:
            span.set_tag("curio.agent", "spawner")
            span.set_tag("curio.topic_id", event.node_id)
            span.set_tag("curio.seal_kind", event.kind)

            # Parent MERGE: clear the margin visuals we made for the now-removed
            # provisional children, mirroring Structuring's descendant cleanup.
            if event.kind == "parent":
                await self._clear_descendants(event.descendant_ids)

            if not event.raw.strip():
                logger.info(f"spawner: empty raw for {event.node_id!r}, skipping")
                return

            plan = await self._decide(event)
            span.set_tag("curio.want_image", plan.get("want_image"))
            span.set_tag("curio.has_term", bool(plan.get("key_term")))

            await self._emit(event.node_id, plan)

    async def _clear_descendants(self, descendant_ids: list[str]) -> None:
        for desc_id in descendant_ids:
            for block_id in self._spawned.pop(desc_id, []):
                await execute_tool_call(
                    {"type": "function", "function": {"name": "remove_block", "arguments": {"id": block_id}}},
                    state=self._state,
                    bridge=self._bridge,
                    active_topic=desc_id,
                )

    async def _decide(self, event: SealEvent) -> dict[str, Any]:
        user = (
            f"TOPIC: {event.label!r}\n"
            f"SEAL KIND: {event.kind} "
            f"({'whole subtree' if event.kind == 'parent' else 'single leaf'})\n\n"
            f"RAW TRANSCRIPT:\n{event.raw}"
        )
        messages = [
            {"role": "system", "content": _DECIDE_SYSTEM},
            {"role": "user", "content": user},
        ]
        tool_calls = await self._call_llm(
            self._config["model"],  # type: ignore[index]
            messages,
            _DECIDE_TOOL,
            forced_tool="plan_support",
        )
        if not tool_calls:
            return {"want_image": False, "reason": "decider returned nothing"}
        return _parse_args(tool_calls[0])

    async def _emit(self, node_id: str, plan: dict[str, Any]) -> None:
        """Deterministically turn the plan into margin board ops (no second LLM call)."""
        anchor = {"near": node_id, "dir": _MARGIN_DIR}
        emitted: list[str] = []

        # 1. Illustrative image (faithful, concrete).
        if plan.get("want_image") and str(plan.get("image_prompt", "")).strip():
            img_id = f"{node_id}__img"
            img_args: dict[str, Any] = {
                "id": img_id,
                "topicId": node_id,
                "prompt": str(plan["image_prompt"]).strip(),
                "anchor": anchor,
            }
            caption = str(plan.get("image_caption", "")).strip()
            if caption:
                img_args["caption"] = caption
            if await self._send_tool("add_image", img_args, active_topic=node_id):
                emitted.append(img_id)

        # 2. Key-term sticky (restates a term the student used — no new facts).
        term = str(plan.get("key_term", "")).strip()
        gloss = str(plan.get("term_gloss", "")).strip()
        if term and gloss:
            term_id = f"{node_id}__term"
            if await self._send_tool(
                "add_sticky",
                {"id": term_id, "text": f"{term} — {gloss}", "anchor": anchor},
                active_topic=node_id,
            ):
                emitted.append(term_id)

        if emitted:
            # Reuse-safe: a re-seal (RETURN→re-seal) upserts the same ids, so just
            # overwrite the tracked set rather than accumulating stale ids.
            self._spawned[node_id] = emitted
            logger.info(f"spawner: added margin visuals {emitted} for {node_id!r}")
        else:
            logger.info(
                f"spawner: nothing to add for {node_id!r} — {plan.get('reason', 'no support')}"
            )

    async def _send_tool(self, tool_name: str, args: dict[str, Any], *, active_topic: str) -> bool:
        result = await execute_tool_call(
            {"type": "function", "function": {"name": tool_name, "arguments": args}},
            state=self._state,
            bridge=self._bridge,
            active_topic=active_topic,
        )
        if not result.get("ok"):
            logger.warning(f"spawner: {tool_name} failed for {args.get('id')!r}: {result.get('error')}")
            return False
        return True

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
                "max_tokens": 800,
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
            logger.error(f"SpawnerAgent._call_llm error: {exc}")
            sentry_sdk.capture_exception(exc)
            return []


def _parse_args(tool_call: dict[str, Any]) -> dict[str, Any]:
    raw = tool_call.get("function", {}).get("arguments", {})
    try:
        args = json.loads(raw) if isinstance(raw, str) else (raw or {})
        return args if isinstance(args, dict) else {}
    except Exception:
        return {}

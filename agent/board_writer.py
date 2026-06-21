"""board_writer.py — Board brain v2 (three-phase, tool-calling FrameProcessor).

This is the CALLER channel of Curio's dual-channel voice→whiteboard harness.
The speaking agent (bot.py) and this module observe the SAME Flux STT stream;
they run in parallel and never block each other.

Three phases
============

Phase 1 — Live ASR (no LLM)
  Observes InterimTranscriptionFrame. Coalesces rapid updates (~10–15/s) by
  dropping frames whose text hasn't changed enough OR that arrived within 70 ms
  of the previous push. Mirrors the partial text verbatim into a ``live``
  scratch block (addMarkdown id="live") so the student sees words appear as they
  speak. No Redis write of content (it's transient).

Phase 2 — End-of-turn structuring (one LLM tool-calling pass per turn)
  Observes final TranscriptionFrame (Flux EndOfTurn). Acquires the async lock
  and runs ONE call to _call_llm():
      system  — board brain job + continue-vs-new rules + never invent
      context — injected state.get_state_summary() (compact board snapshot)
      user    — the turn's final transcript
      tools   — TOOL_SCHEMAS (7 tools from board_tools.py)
  Executes the returned tool_calls via execute_tool_call().
  • "continue" → model reuses an existing block id → update in place.
  • "new block" → model mints a fresh id → create new block; possibly new topic.
  Continue-vs-new is decided by whether the model picks an id that already
  exists in state or invents a new one.
  The first write of a turn also morphs / swaps the ``live`` block:
      text artifact  → live block becomes the topic block in place (morph)
      shape artifact → live block is removed, shape is created nearby (swap)
  Every written block is tagged with the active topicId (tracked in Redis).
  If the model opens a NEW topicId, Phase 3 is enqueued for the prior topic
  before the new topic is opened.

Phase 3 — Topic-end consolidation (one LLM pass per sealed topic)
  Triggered by (a) Phase 2 detecting a new topicId or (b) an idle timeout
  (~8 s) with no continuation.
  Gathers all blocks belonging to the sealed topic (state.get_topic_blocks()),
  runs ONE _call_llm() pass: "understand this topic, choose the tool that best
  fits the content" → produces ONE consolidated artifact (reusing a stable
  per-topic id) and remove_block()s the fragments. The replacement is ALWAYS
  written before any fragment is removed.
  Runs under the same lock; failure leaves per-turn pieces intact (never a
  regression). The consolidated artifact's id is ``consolidated_{topicId}``.

  NOTE: boardApi.addMindMap uses a single global center id derived from the
  block id. Multiple simultaneous mind maps from different topics can collide
  at the board level. We avoid relying on per-topic mindmap centers; this is a
  known board-side limitation, not fixed here.

Non-blocking guarantees (INVARIANT)
=====================================
- process_frame ALWAYS calls push_frame, even during / after errors.
- All LLM + bridge + Redis work runs as asyncio.create_task (fire-and-forget).
- The asyncio.Lock serializes tasks (read-after-write ordering).
- ALL exceptions are caught, logged (loguru), sent to Sentry, and DROPPED.
- If no board-brain LLM key is configured the brain disables itself: voice
  runs fully, Phase 1 still sends raw text to the bridge.

Injectability for tests
========================
- _call_llm(self, messages, tools) → list[dict]  (tool_calls)
    monkeypatch this to return canned tool_calls without network.
- Pass bridge=FakeBridge() to skip the HTTP bridge.
- Pass state=FakeState() (or a fakeredis-backed BoardState) to skip Redis.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Any

import httpx
import sentry_sdk
from loguru import logger

from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from board_state import BoardState, InMemoryBoardState
from board_tools import TOOL_SCHEMAS, BridgePoster, execute_tool_call

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_DEFAULT_SEND_URL = "http://localhost:3000/api/board/send"
_DEFAULT_REDIS_URL = "redis://localhost:6379"
_LIVE_BLOCK_ID = "live"

# Phase 1 throttle: only push if text changed enough OR >=70 ms have elapsed.
_PHASE1_MIN_INTERVAL_S = 0.070          # 70 ms → ~14 fps max
_PHASE1_MIN_CHAR_DELTA = 3              # fewer changed chars → skip unless timer elapsed

# Phase 3 idle timeout: seal the trailing topic after 8 s of silence.
_IDLE_TIMEOUT_S = 8.0

# ---------------------------------------------------------------------------
# LLM config resolution
# ---------------------------------------------------------------------------

def _resolve_board_brain_config() -> dict[str, Any] | None:
    """Resolve an OpenAI-compatible endpoint for the board brain.

    Order (independent of the speaking agent):
      1. AI_GATEWAY_API_KEY  →  Claude Sonnet via Vercel AI Gateway
      2. ZAI_API_KEY         →  GLM-5 turbo (fast tool-caller)
      MUST NOT fall through to NVIDIA/Nemotron — too weak at tool calls.
    Returns None → brain disabled (Phase 1 still runs if bridge reachable).

    An optional "extra" dict is merged into the chat-completion request body
    (provider-specific knobs that aren't standard OpenAI params).
    """
    gateway_key = os.getenv("AI_GATEWAY_API_KEY")
    if gateway_key:
        return {
            "base_url": "https://ai-gateway.vercel.sh/v1",
            "api_key": gateway_key,
            "model": os.getenv("CALLER_MODEL", "anthropic/claude-sonnet-4-6"),
        }
    zai_key = os.getenv("ZAI_API_KEY")
    if zai_key:
        return {
            "base_url": os.getenv("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4/"),
            "api_key": zai_key,
            "model": os.getenv("CALLER_MODEL") or os.getenv("ZAI_MODEL", "glm-5-turbo"),
            # GLM reasons by default (~150 reasoning tokens/turn), leaking its
            # chain-of-thought into `content` and tripling latency. The board
            # brain only needs tool calls, so disable thinking outright.
            "extra": {"thinking": {"type": "disabled"}},
        }
    # NVIDIA/Nemotron deliberately excluded — poor tool-call reliability.
    return None


# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

_PHASE2_SYSTEM = """\
You are the board brain for Curio, a voice-first note-taking app. A student is
explaining a topic out loud (Feynman technique). Your job: turn each spoken turn
into ONE structured artifact on a whiteboard using the provided tools.

Rules:
• NEVER invent facts not present in the student's words.
• Choose the artifact type that fits the content:
    - prose/list/table → write_notes
    - sequential steps/process → make_flowchart
    - relationships/branches → make_mindmap
    - (image stubs are available too)
• Continue-vs-new: if the student is still on the same topic/thread, REUSE the
  existing block id from the board state (continuation = same id). If they have
  moved to a genuinely new topic, mint a new topicId and a new block id.
• The topicId is a short kebab-case label for the topic thread (e.g.
  "photosynthesis", "civil-war-causes"). Persist it across turns of the same
  topic. When the topicId changes, the previous topic is considered sealed.
• Block ids are stable semantic keys (e.g. "notes_photosynthesis"). Reuse them
  to update in place.
• Output ONLY tool calls — no prose, no explanation.
"""

_PHASE3_SYSTEM = """\
You are consolidating a completed topic from a student's spoken braindump. You
will receive all the whiteboard blocks that belong to this topic. Your job:
produce ONE clean, comprehensive artifact that best represents the topic and
issue remove_block calls to delete the now-merged fragments.

Rules:
• Choose the SINGLE artifact type that best fits the topic content:
    sequential/process → make_flowchart
    relationships/branches/concept map → make_mindmap
    comparison/table/prose → write_notes
• Reuse the consolidated id provided (e.g. "consolidated_<topicId>").
• ALWAYS call the artifact tool FIRST, then issue remove_block for each
  fragment. NEVER remove a fragment before its replacement is written.
• NEVER invent facts — only synthesize from the provided block content.
• Output ONLY tool calls — no prose, no explanation.
"""

# ---------------------------------------------------------------------------
# BoardWriter
# ---------------------------------------------------------------------------


class BoardWriter(FrameProcessor):
    """Pass-through FrameProcessor — the board brain v2.

    Insert right after the STT service. Forwards every frame untouched.
    Fires board work as asyncio.create_task (non-blocking).
    See module docstring for the three-phase design.

    Constructor
    -----------
    session : str
        Redis session namespace (conversationId from bot.py session payload).
    send_url : str | None
        Override WHITEBOARD_SEND_URL env var.
    state : BoardState | None
        Inject a pre-built state (tests: pass a FakeState / fakeredis state).
    bridge : BridgePoster | None
        Inject a fake bridge in tests.
    """

    def __init__(
        self,
        *,
        session: str = "default",          # bot.py passes conversationId here
        send_url: str | None = None,
        state: Any | None = None,          # duck-typed BoardState; None → auto-build
        bridge: BridgePoster | None = None,
    ):
        super().__init__()

        self._session = session
        self._send_url = send_url or os.getenv("WHITEBOARD_SEND_URL", _DEFAULT_SEND_URL)
        self._config = _resolve_board_brain_config()
        self._llm_enabled = self._config is not None
        self._http = httpx.AsyncClient(timeout=30)

        # Bridge (injected or real). Pass the session so board commands route to
        # the matching browser SSE subscriber (/api/board/stream?session=).
        self._bridge: Any = bridge or BridgePoster(self._send_url, session=self._session)

        # State (injected or real)
        if state is not None:
            self._state: Any = state
            self._owns_state = False
        else:
            # Default to a local in-memory store so the voice→board loop never
            # blocks on a Redis connect. Set BOARD_STATE_BACKEND=redis to use Redis.
            backend = os.getenv("BOARD_STATE_BACKEND", "memory").lower()
            if backend == "redis":
                redis_url = os.getenv("REDIS_URL", _DEFAULT_REDIS_URL)
                self._state = BoardState(redis_url=redis_url, session=session)
            else:
                self._state = InMemoryBoardState(session=session)
            self._owns_state = True

        # Serialization
        self._lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()

        # Phase 1 throttle state
        self._last_live_text: str = ""
        self._last_live_push_at: float = 0.0

        # Phase 2 / 3 tracking
        self._active_topic: str | None = None   # current topicId (in-memory cache)
        self._live_pos: dict[str, float] | None = None  # where the live block was placed

        # Phase 3 idle timeout handle
        self._idle_handle: asyncio.TimerHandle | None = None

        if self._llm_enabled:
            logger.info(
                f"BoardWriter v2 enabled: model={self._config['model']!r} "  # type: ignore[index]
                f"session={session!r} bridge={self._send_url}"
            )
        else:
            logger.warning(
                "BoardWriter v2: no board-brain LLM key "
                "(AI_GATEWAY_API_KEY / ZAI_API_KEY). Phase 2 + 3 disabled. "
                "Phase 1 (live ASR mirror) still active. "
                "Voice pipeline runs normally."
            )

    # ------------------------------------------------------------------
    # pipecat lifecycle
    # ------------------------------------------------------------------

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, InterimTranscriptionFrame):
                text = (frame.text or "").strip()
                if text:
                    self._spawn(self._phase1_live(text))

            elif isinstance(frame, TranscriptionFrame):
                text = (frame.text or "").strip()
                if text:
                    self._spawn(self._phase2_end_of_turn(text))

        # ALWAYS forward — observer, never a sink.
        await self.push_frame(frame, direction)

    async def close(self) -> None:
        """Cancel idle timer, drain in-flight tasks, close resources."""
        self._cancel_idle_timer()
        if self._tasks:
            await asyncio.wait(self._tasks, timeout=5)
        await self._http.aclose()
        close_bridge = getattr(self._bridge, "aclose", None)
        if close_bridge is not None:
            await close_bridge()
        if self._owns_state:
            await self._state.aclose()

    # ------------------------------------------------------------------
    # Internal: task helpers
    # ------------------------------------------------------------------

    def _spawn(self, coro: Any) -> None:
        """Fire-and-forget — keep a strong ref so the task isn't GC'd."""
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # ------------------------------------------------------------------
    # Phase 1 — Live ASR mirror
    # ------------------------------------------------------------------

    async def _phase1_live(self, text: str) -> None:
        """Mirror partial transcript to the live block — no LLM, no lock needed."""
        now = time.monotonic()
        elapsed = now - self._last_live_push_at
        char_delta = abs(len(text) - len(self._last_live_text))

        # Throttle: skip if text barely changed AND interval too short.
        if elapsed < _PHASE1_MIN_INTERVAL_S and char_delta < _PHASE1_MIN_CHAR_DELTA:
            return

        self._last_live_text = text
        self._last_live_push_at = now

        try:
            await self._bridge.send("addMarkdown", {
                "id": _LIVE_BLOCK_ID,
                "markdown": text,
            })
        except Exception as exc:
            logger.debug(f"Phase1 bridge error (non-critical): {exc}")

    # ------------------------------------------------------------------
    # Phase 2 — End-of-turn structuring
    # ------------------------------------------------------------------

    async def _phase2_end_of_turn(self, utterance: str) -> None:
        """Run one tool-calling LLM pass for the finished turn. Serialized."""
        async with self._lock:
            self._cancel_idle_timer()  # reset idle timer on new speech
            try:
                await self._do_phase2(utterance)
            except Exception as exc:
                logger.error(f"Phase2 failed: {exc}")
                sentry_sdk.capture_exception(exc)
            finally:
                # Reschedule idle timer for Phase 3 trailing-topic seal.
                self._arm_idle_timer()

    async def _do_phase2(self, utterance: str) -> None:
        if not self._llm_enabled:
            return

        # Ensure state is connected (no-op if already connected / injected).
        await self._state.connect()

        # Build context: compact board snapshot.
        summary = await self._state.get_state_summary()
        active_topic = self._active_topic or await self._state.get_active_topic() or ""

        context_str = "CURRENT BOARD STATE (existing blocks):\n"
        if summary:
            import json as _json
            context_str += _json.dumps(summary, indent=2)
        else:
            context_str += "(empty — no blocks yet)"

        if active_topic:
            context_str += f"\n\nACTIVE TOPIC: {active_topic!r}"

        messages = [
            {"role": "system", "content": _PHASE2_SYSTEM},
            {"role": "user", "content": f"{context_str}\n\nSTUDENT'S TURN:\n{utterance}"},
        ]

        tool_calls = await self._call_llm(messages, TOOL_SCHEMAS)
        if not tool_calls:
            # No tool calls → LLM gave up or returned nothing; leave live block.
            return

        # Detect topicId from the first tool call that provides one.
        # The model is instructed to include the topicId in every write call.
        # We infer it from the first substantive call's arguments.
        new_topic = self._extract_topic_from_calls(tool_calls)

        # If the model opened a NEW topic, seal the prior one → Phase 3.
        prior_topic: str | None = None
        if new_topic and new_topic != active_topic:
            prior_topic = active_topic or None
            # Update active topic in Redis + local cache.
            self._active_topic = new_topic
            await self._state.set_active_topic(new_topic)

        effective_topic = new_topic or active_topic or _fresh_topic_id()
        if not self._active_topic:
            self._active_topic = effective_topic
            await self._state.set_active_topic(effective_topic)

        # Execute tool calls in order. The first write-type call handles the
        # live→artifact morph/swap; subsequent calls are additional artifacts.
        first_write = True
        for tc in tool_calls:
            fn_name = tc.get("function", {}).get("name", "")
            await execute_tool_call(
                tc,
                state=self._state,
                bridge=self._bridge,
                active_topic=effective_topic,
            )
            if first_write and fn_name in ("write_notes", "make_flowchart", "make_mindmap", "add_image"):
                # Morph / swap the live block.
                await self._morph_live(fn_name, tc)
                first_write = False

        # Enqueue Phase 3 for the now-sealed prior topic.
        if prior_topic:
            self._spawn(self._phase3_consolidate(prior_topic))

    def _extract_topic_from_calls(self, tool_calls: list[dict[str, Any]]) -> str:
        """Pull topicId from the first tool call that has one in its arguments."""
        import json as _json
        for tc in tool_calls:
            raw_args = tc.get("function", {}).get("arguments", {})
            try:
                args: dict[str, Any] = (
                    _json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                )
            except Exception as exc:
                logger.warning(f"Skipping malformed tool-call arguments while extracting topic: {exc}")
                continue
            topic = args.get("topicId", "") if isinstance(args, dict) else ""
            if topic:
                return str(topic)
        return ""

    async def _morph_live(self, fn_name: str, tool_call: dict[str, Any]) -> None:
        """After the first artifact write, clean up the live block.

        Text artifacts (write_notes): the live block is conceptually replaced
        in-place — the new addMarkdown with the block's own id already occupies
        the canvas. Send a removeNode for the "live" id to tidy up.

        Shape artifacts (flowchart / mindmap / image): remove the live block
        and let the shape claim its region.
        """
        try:
            await self._bridge.send("removeNode", {"id": _LIVE_BLOCK_ID})
        except Exception as exc:
            logger.debug(f"_morph_live removeNode(live) failed (non-critical): {exc}")
        # Reset Phase 1 state for next turn.
        self._last_live_text = ""
        self._last_live_push_at = 0.0

    # ------------------------------------------------------------------
    # Phase 3 — Topic-end consolidation
    # ------------------------------------------------------------------

    def _arm_idle_timer(self) -> None:
        """Schedule Phase 3 for the active topic after _IDLE_TIMEOUT_S of silence."""
        loop = asyncio.get_event_loop()
        self._idle_handle = loop.call_later(
            _IDLE_TIMEOUT_S, self._idle_timeout_fired
        )

    def _cancel_idle_timer(self) -> None:
        if self._idle_handle is not None:
            self._idle_handle.cancel()
            self._idle_handle = None

    def _idle_timeout_fired(self) -> None:
        """Called from the event-loop timer — spawn Phase 3 for trailing topic."""
        self._idle_handle = None
        topic = self._active_topic
        if topic:
            logger.info(f"BoardWriter idle timeout — sealing trailing topic {topic!r}")
            self._spawn(self._phase3_consolidate_locked(topic))

    async def _phase3_consolidate(self, sealed_topic: str) -> None:
        """Acquire the lock and run Phase 3 for the given topic."""
        async with self._lock:
            try:
                await self._do_phase3(sealed_topic)
            except Exception as exc:
                logger.error(f"Phase3 consolidation failed for {sealed_topic!r}: {exc}")
                sentry_sdk.capture_exception(exc)

    async def _phase3_consolidate_locked(self, sealed_topic: str) -> None:
        """Phase 3 entry point from the idle timer (same as _phase3_consolidate)."""
        await self._phase3_consolidate(sealed_topic)

    async def _do_phase3(self, sealed_topic: str) -> None:
        if not self._llm_enabled:
            return

        blocks = await self._state.get_topic_blocks(sealed_topic)
        if not blocks:
            logger.debug(f"Phase3: no blocks for topic {sealed_topic!r}, skipping")
            return

        # Build the context message from the topic's blocks.
        import json as _json
        blocks_text = _json.dumps(
            [
                {
                    "id": b.get("id"),
                    "type": b.get("type"),
                    "title": b.get("title"),
                    "content": b.get("content", "")[:800],  # cap content per block
                }
                for b in blocks
            ],
            indent=2,
        )

        consolidated_id = f"consolidated_{sealed_topic}"
        fragment_ids = [b["id"] for b in blocks if b.get("id") != consolidated_id]

        user_msg = (
            f"Topic: {sealed_topic!r}\n"
            f"Consolidated artifact id to use: {consolidated_id!r}\n\n"
            f"BLOCKS TO CONSOLIDATE:\n{blocks_text}\n\n"
            f"Fragment ids to remove (after writing the consolidated artifact): "
            f"{_json.dumps(fragment_ids)}"
        )

        messages = [
            {"role": "system", "content": _PHASE3_SYSTEM},
            {"role": "user", "content": user_msg},
        ]

        tool_calls = await self._call_llm(messages, TOOL_SCHEMAS)
        if not tool_calls:
            logger.debug(f"Phase3: no tool calls returned for {sealed_topic!r}")
            return

        # SAFETY: regardless of the order the LLM emitted them, always execute
        # create/write calls BEFORE remove_block calls so a fragment is never
        # deleted before its replacement is on the board.
        ordered = _sort_writes_before_removes(tool_calls)

        for tc in ordered:
            fn_name = tc.get("function", {}).get("name", "")
            await execute_tool_call(
                tc,
                state=self._state,
                bridge=self._bridge,
                active_topic=sealed_topic,
            )
            logger.debug(f"Phase3 executed {fn_name!r} for topic {sealed_topic!r}")

    # ------------------------------------------------------------------
    # LLM call — injectable for tests (monkeypatch _call_llm)
    # ------------------------------------------------------------------

    async def _call_llm(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Call the board-brain LLM and return tool_calls.

        This method is intentionally a thin wrapper so tests can monkeypatch it:
            writer._call_llm = AsyncMock(return_value=[canned_tool_call])

        Returns an empty list on any error (never raises).
        """
        assert self._config is not None
        try:
            body: dict[str, Any] = {
                "model": self._config["model"],
                "messages": messages,
                "tools": tools,
                "tool_choice": "auto",
                "temperature": 0.2,
                "max_tokens": 2000,
            }
            # Provider-specific knobs (e.g. GLM's thinking switch).
            body.update(self._config.get("extra") or {})
            resp = await self._http.post(
                f"{self._config['base_url'].rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {self._config['api_key']}"},
                json=body,
                timeout=25,
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
            choice = data.get("choices", [{}])[0]
            msg = choice.get("message", {})
            tool_calls = msg.get("tool_calls") or []
            finish = choice.get("finish_reason")
            if tool_calls:
                names = [tc.get("function", {}).get("name") for tc in tool_calls]
                logger.info(
                    f"board-brain ({self._config['model']}): {len(tool_calls)} "
                    f"tool_call(s) {names} finish={finish}"
                )
            else:
                # No tools called — log what the model said instead so it's
                # obvious WHY nothing reached the board (weak tool-caller, refusal,
                # endpoint that ignores `tools`, etc.).
                said = (msg.get("content") or "")[:300]
                logger.warning(
                    f"board-brain ({self._config['model']}) returned NO tool_calls "
                    f"(finish={finish}). Model said instead: {said!r}"
                )
            return tool_calls
        except Exception as exc:
            logger.error(f"BoardWriter _call_llm error: {exc}")
            sentry_sdk.capture_exception(exc)
            return []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Tools that CREATE or UPDATE content on the board (must run before removes).
_CREATE_TOOLS: frozenset[str] = frozenset({
    "write_notes", "make_flowchart", "make_mindmap", "add_image",
})
# Tools that REMOVE content (must run after all creates).
_REMOVE_TOOLS: frozenset[str] = frozenset({"remove_block", "clear_board"})


def _sort_writes_before_removes(
    tool_calls: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Reorder *tool_calls* so every create/write call precedes every remove call.

    Preserves relative order within each group (stable partition).
    This prevents a fragment from being deleted before its replacement is written,
    even when the LLM emits removes first.
    """
    creates = [tc for tc in tool_calls
                if tc.get("function", {}).get("name", "") in _CREATE_TOOLS]
    removes = [tc for tc in tool_calls
                if tc.get("function", {}).get("name", "") in _REMOVE_TOOLS]
    others  = [tc for tc in tool_calls
                if tc.get("function", {}).get("name", "") not in _CREATE_TOOLS | _REMOVE_TOOLS]
    # Order: creates → other (e.g. highlight) → removes
    return creates + others + removes


def _fresh_topic_id() -> str:
    """Generate a short unique topic id when the model doesn't provide one."""
    return f"topic_{uuid.uuid4().hex[:8]}"

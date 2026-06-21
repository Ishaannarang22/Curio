"""topic_boundary.py — the pipecat FrameProcessor that runs topic boundary detection.

This is the live wiring of Curio's **topic boundary** (prd.md §1.2–1.3). It replaces
``board_writer.py``'s prototype trigger model (8 s idle timer + LLM ``topicId``
minting) with the locked, semantic, per-turn classifier (decisions #19–22).

Per finished utterance (Flux ``EndOfTurn``) it:
  1. classifies the move against the topic tree (``TopicClassifier``),
  2. applies it to the tree (``TopicTree.apply``),
  3. mirrors the active node's raw to the board (live verbatim, prd.md §1.1 — NOT an
     agent, just persistent transcription), and
  4. fires a ``SealEvent`` through the **seal seam** for every node that just sealed.

What this does NOT do
=====================
It does **not** structure anything. Each seal is handed to ``on_seal`` — the seam the
**Structuring Agent** (next task, implementation.md §1.2) will own. Until that agent
exists, ``on_seal`` defaults to a logger: the boundary engine is fully live and
observable, but the board shows raw per-topic blocks rather than artifacts. That
regression is intentional and temporary (the seal contract is now stable).

Non-blocking guarantees (INVARIANT, inherited from the dual-channel design)
===========================================================================
- ``process_frame`` ALWAYS calls ``push_frame`` — observer, never a sink.
- All classify / bridge / seal work runs as ``asyncio.create_task`` (fire-and-forget),
  serialized by an ``asyncio.Lock`` so the tree mutates in turn order.
- Every exception is caught, logged, sent to Sentry, and dropped. The voice pipeline
  never sees an error from here.
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Awaitable, Callable, Optional

import sentry_sdk
from loguru import logger

from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from board_state import InMemoryBoardState
from board_tools import BridgePoster, execute_tool_call
from topic_classifier import TopicClassifier
from topic_tree import SealEvent, TopicTree

_DEFAULT_SEND_URL = "http://localhost:3000/api/board/send"
_LIVE_BLOCK_ID = "live"

# Live-mirror throttle: push only if the text changed enough OR enough time passed.
_LIVE_MIN_INTERVAL_S = 0.070  # ~14 fps cap
_LIVE_MIN_CHAR_DELTA = 3

# Seal seam: an async callback the Structuring Agent will provide next session.
SealHandler = Callable[[SealEvent], Awaitable[None]]


class TopicBoundaryProcessor(FrameProcessor):
    """Observes the Flux transcript stream and runs topic boundary detection.

    Insert right after the STT service (where ``BoardWriter`` used to sit). Forwards
    every frame untouched.

    Parameters
    ----------
    session : Redis / bridge session namespace (the conversationId from bot.py).
    on_seal : async callback fired for each sealed node. Defaults to a logger (the
        Structuring Agent seam — see module docstring).
    state : the BoardState the raw blocks are tracked in. Share the SAME instance
        with the StructuringAgent so placement avoids overlap and a render can
        replace a raw block in place. Falls back to a private in-memory store.
    classifier, bridge : injected in tests; built from env otherwise.
    """

    def __init__(
        self,
        *,
        session: str = "default",
        send_url: str | None = None,
        on_seal: Optional[SealHandler] = None,
        state: Any | None = None,
        classifier: TopicClassifier | None = None,
        bridge: Any | None = None,
    ):
        super().__init__()
        self._session = session
        self._send_url = send_url or os.getenv("WHITEBOARD_SEND_URL", _DEFAULT_SEND_URL)

        self._tree = TopicTree(root_label=session)
        self._classifier = classifier or TopicClassifier()
        self._bridge: Any = bridge or BridgePoster(self._send_url, session=self._session)
        self._on_seal: SealHandler = on_seal or self._default_seal_log
        # Shared with the StructuringAgent (bot.py wires the same instance); we never
        # close it here — its owner does.
        self._state: Any = state if state is not None else InMemoryBoardState(session=session)

        self._lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()

        # Live-mirror throttle state.
        self._last_live_text = ""
        self._last_live_push_at = 0.0

        logger.info(
            f"TopicBoundaryProcessor active: session={session!r} "
            f"classifier={'on' if self._classifier.enabled else 'off'} bridge={self._send_url}"
        )

    # ------------------------------------------------------------------
    # pipecat lifecycle
    # ------------------------------------------------------------------

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM:
            _cls = type(frame).__name__
            if "Transcription" in _cls:
                logger.info(f"[TBP-debug] saw {_cls} text={(getattr(frame, 'text', '') or '')[:80]!r}")
            if isinstance(frame, InterimTranscriptionFrame):
                text = (frame.text or "").strip()
                if text:
                    self._spawn(self._live_mirror(text))
            elif isinstance(frame, TranscriptionFrame):
                text = (frame.text or "").strip()
                if text:
                    self._spawn(self._on_utterance(text))

        # ALWAYS forward — observer, never a sink.
        await self.push_frame(frame, direction)

    async def close(self) -> None:
        """Session end: seal the trailing topic, drain tasks, close resources."""
        try:
            async with self._lock:
                events = self._tree.seal_trailing()
            for event in events:
                await self._fire_seal(event)
        except Exception as exc:  # never let teardown raise
            logger.error(f"TopicBoundary trailing seal failed: {exc}")
            sentry_sdk.capture_exception(exc)

        if self._tasks:
            await asyncio.wait(self._tasks, timeout=5)
        await self._classifier.aclose()
        close_bridge = getattr(self._bridge, "aclose", None)
        if close_bridge is not None:
            await close_bridge()

    # ------------------------------------------------------------------
    # Task helper
    # ------------------------------------------------------------------

    def _spawn(self, coro: Awaitable[None]) -> None:
        task = asyncio.create_task(coro)  # type: ignore[arg-type]
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # ------------------------------------------------------------------
    # Live verbatim mirror (prd.md §1.1 — not gated by any agent)
    # ------------------------------------------------------------------

    async def _live_mirror(self, text: str) -> None:
        """Mirror the partial transcript to the transient ``live`` block. No LLM."""
        now = time.monotonic()
        elapsed = now - self._last_live_push_at
        if elapsed < _LIVE_MIN_INTERVAL_S and abs(len(text) - len(self._last_live_text)) < _LIVE_MIN_CHAR_DELTA:
            return
        self._last_live_text = text
        self._last_live_push_at = now
        try:
            await self._bridge.send("addMarkdown", {"id": _LIVE_BLOCK_ID, "markdown": text})
        except Exception as exc:
            logger.debug(f"live mirror bridge error (non-critical): {exc}")

    # ------------------------------------------------------------------
    # End-of-turn: classify → apply → mirror raw → fire seals
    # ------------------------------------------------------------------

    async def _on_utterance(self, utterance: str) -> None:
        async with self._lock:
            try:
                verdict = await self._classifier.classify(
                    skeleton=self._tree.render_skeleton(),
                    active_raw=self._tree.active_raw(),
                    utterance=utterance,
                )
                events = self._tree.apply(verdict, utterance)
                logger.info(
                    f"topic-move {verdict.move.value} "
                    f"-> active={self._tree.active.id!r} ({self._tree.active.label!r}); "
                    f"{len(events)} seal(s)"
                )
                await self._render_active_raw()
                for event in events:
                    await self._fire_seal(event)
            except Exception as exc:
                logger.error(f"TopicBoundary _on_utterance failed: {exc}")
                sentry_sdk.capture_exception(exc)

    async def _render_active_raw(self) -> None:
        """Persist the active node's raw as its own board block (verbatim, prd.md §1.1).

        Goes through the ``write_notes`` tool so the block is **placement-tracked**
        in the shared BoardState (lattice-packed, no overlap) and keyed by the node
        id — letting the StructuringAgent replace it in place on seal. Replaces the
        transient ``live`` block.
        """
        node = self._tree.active
        if node is self._tree.root:
            return
        tool_call = {
            "type": "function",
            "function": {
                "name": "write_notes",
                "arguments": {
                    "id": node.id,
                    "topicId": node.id,
                    "title": node.label,
                    "markdown": f"## {node.label}\n\n{node.own_raw()}",
                },
            },
        }
        try:
            await execute_tool_call(
                tool_call, state=self._state, bridge=self._bridge, active_topic=node.id
            )
            await self._bridge.send("removeNode", {"id": _LIVE_BLOCK_ID})
        except Exception as exc:
            logger.debug(f"render active raw bridge error (non-critical): {exc}")
        self._last_live_text = ""
        self._last_live_push_at = 0.0

    # ------------------------------------------------------------------
    # Seal seam — the Structuring Agent's trigger
    # ------------------------------------------------------------------

    async def _fire_seal(self, event: SealEvent) -> None:
        try:
            await self._on_seal(event)
        except Exception as exc:
            logger.error(f"on_seal handler failed for {event.node_id!r}: {exc}")
            sentry_sdk.capture_exception(exc)

    async def _default_seal_log(self, event: SealEvent) -> None:
        """Placeholder seal handler until the Structuring Agent is built (next task)."""
        logger.info(
            f"SEAL [{event.kind}] {event.label!r} ({event.node_id}) "
            f"reason={event.reason} raw_chars={len(event.raw)} "
            f"— Structuring Agent not yet wired"
        )

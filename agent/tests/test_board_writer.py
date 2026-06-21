"""Tests for agent/board_writer.py (M3 — board brain v2).

All tests are offline: LLM calls are monkeypatched, the bridge is a FakeBridge,
and state is a FakeState (in-memory) — no network, no Redis, no HTTP.

pytest-asyncio is activated per-module via pytestmark (same pattern as the
other test files) to avoid touching pyproject.toml.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio

# ---------------------------------------------------------------------------
# pytest-asyncio module-level asyncio mode
# ---------------------------------------------------------------------------

pytestmark = pytest.mark.asyncio

# ---------------------------------------------------------------------------
# Fake helpers (match the duck-typed M1 / bridge interfaces)
# ---------------------------------------------------------------------------


class FakeBridge:
    """Records every (action, payload) posted."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, action: str, payload: dict[str, Any]) -> None:
        self.sent.append({"action": action, "payload": payload})

    def actions(self) -> list[str]:
        return [s["action"] for s in self.sent]

    def payloads_for(self, action: str) -> list[dict[str, Any]]:
        return [s["payload"] for s in self.sent if s["action"] == action]


class FakeState:
    """In-memory BlockRecord store implementing the M1 duck-typed interface."""

    def __init__(self) -> None:
        self._blocks: dict[str, dict[str, Any]] = {}
        self._active_topic: str | None = None

    async def connect(self) -> None:
        pass

    async def aclose(self) -> None:
        pass

    async def upsert_block(self, rec: dict[str, Any]) -> None:
        self._blocks[rec["id"]] = dict(rec)

    async def get_block(self, block_id: str) -> dict[str, Any] | None:
        return self._blocks.get(block_id)

    async def remove_block(self, block_id: str) -> None:
        self._blocks.pop(block_id, None)

    async def update_geometry(self, block_id: str, bbox: dict[str, float]) -> None:
        if block_id in self._blocks:
            self._blocks[block_id]["bbox"] = bbox

    async def get_topic_blocks(self, topic_id: str) -> list[dict[str, Any]]:
        return [b for b in self._blocks.values() if b.get("topicId") == topic_id]

    async def get_state_summary(self) -> list[dict[str, Any]]:
        return [
            {
                "id": b["id"],
                "topicId": b.get("topicId", ""),
                "type": b.get("type", ""),
                "title": b.get("title", ""),
                "summary": (b.get("content", "") or "")[:120],
                "bbox": b.get("bbox") or {"x": 0, "y": 0, "w": 0, "h": 0},
            }
            for b in self._blocks.values()
        ]

    async def set_active_topic(self, topic_id: str) -> None:
        self._active_topic = topic_id

    async def get_active_topic(self) -> str | None:
        return self._active_topic

    async def clear(self) -> None:
        self._blocks.clear()
        self._active_topic = None


# ---------------------------------------------------------------------------
# Fake pipecat frame classes (avoid importing pipecat in this unit-test file
# so tests stay fast and dependency-light)
# ---------------------------------------------------------------------------

from dataclasses import dataclass, field


@dataclass
class FakeFrame:
    text: str = ""


@dataclass
class FakeInterimFrame(FakeFrame):
    user_id: str = ""
    timestamp: str = ""


@dataclass
class FakeFinalFrame(FakeFrame):
    user_id: str = ""
    timestamp: str = ""


# ---------------------------------------------------------------------------
# Helper: build a BoardWriter with fakes, LLM disabled (no env key).
# The _call_llm method is overridden per-test via monkeypatch.
# ---------------------------------------------------------------------------

from board_writer import BoardWriter


def _make_writer(bridge: FakeBridge, state: FakeState, session: str = "test") -> BoardWriter:
    """Return a BoardWriter with injected fake bridge + state, LLM key unset."""
    w = BoardWriter(session=session, bridge=bridge, state=state)
    # Force LLM-enabled so phases 2 & 3 run (config without a real key)
    w._llm_enabled = True
    w._config = {
        "base_url": "http://fake-llm/v1",
        "api_key": "fake-key",
        "model": "fake-model",
    }
    return w


# ---------------------------------------------------------------------------
# Fake pipecat FrameDirection and push_frame plumbing
# ---------------------------------------------------------------------------

from pipecat.processors.frame_processor import FrameDirection

# ---------------------------------------------------------------------------
# Helper: a minimal stub so push_frame doesn't need a real pipeline.
# We patch FrameProcessor.push_frame to just record calls.
# ---------------------------------------------------------------------------

async def _noop_push(self, frame, direction=FrameDirection.DOWNSTREAM):
    """Replace push_frame so we can assert it's always called."""
    if not hasattr(self, "_pushed"):
        self._pushed = []
    self._pushed.append((frame, direction))


# ---------------------------------------------------------------------------
# 1. Phase 2 — continuation: model reuses an existing id → no Phase 3
# ---------------------------------------------------------------------------

async def test_phase2_continuation(monkeypatch):
    """Model reuses an existing block id → update in place, no Phase 3 triggered."""
    bridge = FakeBridge()
    state = FakeState()

    # Pre-populate an existing block
    await state.upsert_block({
        "id": "notes_photosynthesis",
        "topicId": "photosynthesis",
        "type": "notes",
        "title": "Photosynthesis",
        "content": "Light reactions...",
    })
    await state.set_active_topic("photosynthesis")

    writer = _make_writer(bridge, state)
    writer._active_topic = "photosynthesis"

    # Canned tool_call: reuse same id (continuation)
    canned = [
        {
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "write_notes",
                "arguments": json.dumps({
                    "id": "notes_photosynthesis",
                    "topicId": "photosynthesis",
                    "title": "Photosynthesis",
                    "markdown": "## Photosynthesis\n- Light reactions\n- Calvin cycle",
                }),
            },
        }
    ]
    writer._call_llm = AsyncMock(return_value=canned)

    monkeypatch.setattr(
        "pipecat.processors.frame_processor.FrameProcessor.push_frame", _noop_push
    )

    # Trigger Phase 2
    await writer._do_phase2("So the light reactions happen in the thylakoid...")

    # Bridge should have gotten an addMarkdown (from execute_tool_call)
    assert "addMarkdown" in bridge.actions(), f"Expected addMarkdown, got {bridge.actions()}"

    # No Phase 3 — active topic unchanged, no tasks spawned for consolidation
    # (no new topic opened)
    assert writer._active_topic == "photosynthesis"

    # Block should have been updated in state
    block = await state.get_block("notes_photosynthesis")
    assert block is not None
    assert block["topicId"] == "photosynthesis"


# ---------------------------------------------------------------------------
# 2. Phase 2 — new topic: model mints a new id → prior topic sealed → Phase 3
# ---------------------------------------------------------------------------

async def test_phase2_new_topic_triggers_phase3(monkeypatch):
    """Model mints a new topicId → prior topic is sealed → Phase 3 is spawned."""
    bridge = FakeBridge()
    state = FakeState()

    # Pre-populate old topic block
    await state.upsert_block({
        "id": "notes_civil_war",
        "topicId": "civil-war",
        "type": "notes",
        "title": "Civil War",
        "content": "Started 1861...",
    })
    await state.set_active_topic("civil-war")

    writer = _make_writer(bridge, state)
    writer._active_topic = "civil-war"

    # Track Phase 3 invocations via _do_phase3 (the actual work, not the
    # lock-wrapper) so we catch it regardless of task scheduling.
    phase3_calls: list[str] = []
    original_do_phase3 = writer._do_phase3

    async def fake_do_phase3(sealed_topic: str) -> None:
        phase3_calls.append(sealed_topic)

    writer._do_phase3 = fake_do_phase3

    # Canned call: NEW topic "reconstruction"
    canned = [
        {
            "id": "call_2",
            "type": "function",
            "function": {
                "name": "write_notes",
                "arguments": json.dumps({
                    "id": "notes_reconstruction",
                    "topicId": "reconstruction",
                    "title": "Reconstruction",
                    "markdown": "## Reconstruction Era\n- Post Civil War period",
                }),
            },
        }
    ]
    writer._call_llm = AsyncMock(return_value=canned)

    monkeypatch.setattr(
        "pipecat.processors.frame_processor.FrameProcessor.push_frame", _noop_push
    )

    await writer._do_phase2("Now let me talk about the Reconstruction era...")

    # Active topic should have changed
    assert writer._active_topic == "reconstruction"
    redis_topic = await state.get_active_topic()
    assert redis_topic == "reconstruction"

    # Give spawned Phase 3 task a chance to run.
    await asyncio.sleep(0.05)

    # Phase 3 should have been called for the prior topic
    assert "civil-war" in phase3_calls, f"Phase3 not called for civil-war; calls={phase3_calls}"

    # New block should exist
    block = await state.get_block("notes_reconstruction")
    assert block is not None


# ---------------------------------------------------------------------------
# 3. Phase 3 — consolidation: fragments collapsed into one artifact
# ---------------------------------------------------------------------------

async def test_phase3_consolidation():
    """Multiple fragment blocks → one consolidated artifact + fragments removed."""
    bridge = FakeBridge()
    state = FakeState()

    topic_id = "photosynthesis"

    # Plant several fragment blocks in the topic
    for i in range(3):
        await state.upsert_block({
            "id": f"frag_{i}",
            "topicId": topic_id,
            "type": "notes",
            "title": f"Fragment {i}",
            "content": f"Content {i}",
            "shapeIds": [f"frag_{i}"],
        })

    writer = _make_writer(bridge, state)

    consolidated_id = f"consolidated_{topic_id}"

    # Canned Phase 3 calls: one artifact + three remove_block calls
    canned = [
        {
            "id": "call_c0",
            "type": "function",
            "function": {
                "name": "make_flowchart",
                "arguments": json.dumps({
                    "id": consolidated_id,
                    "topicId": topic_id,
                    "title": "Photosynthesis Process",
                    "steps": [
                        {"id": "s1", "label": "Light absorption"},
                        {"id": "s2", "label": "Water splitting"},
                        {"id": "s3", "label": "ATP synthesis"},
                    ],
                }),
            },
        },
        {
            "id": "call_c1",
            "type": "function",
            "function": {
                "name": "remove_block",
                "arguments": json.dumps({"id": "frag_0"}),
            },
        },
        {
            "id": "call_c2",
            "type": "function",
            "function": {
                "name": "remove_block",
                "arguments": json.dumps({"id": "frag_1"}),
            },
        },
        {
            "id": "call_c3",
            "type": "function",
            "function": {
                "name": "remove_block",
                "arguments": json.dumps({"id": "frag_2"}),
            },
        },
    ]
    writer._call_llm = AsyncMock(return_value=canned)

    await writer._do_phase3(topic_id)

    # Consolidated artifact should exist
    consolidated = await state.get_block(consolidated_id)
    assert consolidated is not None, "Consolidated block not found in state"
    assert consolidated["type"] == "flowchart"

    # Fragments should be removed from state
    for i in range(3):
        assert await state.get_block(f"frag_{i}") is None, f"frag_{i} not removed"

    # Bridge should have received addFlowchart + removeNode × 3
    actions = bridge.actions()
    assert "addFlowchart" in actions, f"No addFlowchart in {actions}"
    remove_count = actions.count("removeNode")
    # Each remove_block fan-outs to one removeNode per shapeId
    assert remove_count >= 3, f"Expected >=3 removeNode calls, got {remove_count} in {actions}"


# ---------------------------------------------------------------------------
# 4. Idle timeout seals the trailing topic
# ---------------------------------------------------------------------------

async def test_idle_timeout_seals_topic():
    """After _IDLE_TIMEOUT_S of silence, Phase 3 fires for the active topic."""
    bridge = FakeBridge()
    state = FakeState()

    await state.upsert_block({
        "id": "notes_trailing",
        "topicId": "trailing",
        "type": "notes",
        "title": "Trailing topic",
        "content": "Some content",
        "shapeIds": ["notes_trailing"],
    })
    await state.set_active_topic("trailing")

    writer = _make_writer(bridge, state)
    writer._active_topic = "trailing"

    # Track Phase 3 invocations
    phase3_calls: list[str] = []

    async def fake_phase3(sealed_topic: str) -> None:
        phase3_calls.append(sealed_topic)

    writer._phase3_consolidate = fake_phase3

    # Use a very short timeout so the test doesn't take 8 s.
    from board_writer import _IDLE_TIMEOUT_S
    writer._arm_idle_timer()

    # Override: fire the timer callback directly (simulate timeout expiring).
    writer._cancel_idle_timer()
    writer._idle_timeout_fired()

    # Give spawned tasks a moment to run.
    await asyncio.sleep(0.05)

    assert "trailing" in phase3_calls, f"Idle timeout did not seal topic; calls={phase3_calls}"


# ---------------------------------------------------------------------------
# 5. Non-blocking: push_frame is ALWAYS called, even during/after errors
# ---------------------------------------------------------------------------

async def test_process_frame_always_pushes():
    """process_frame MUST forward every frame even when LLM errors out."""
    bridge = FakeBridge()
    state = FakeState()
    writer = _make_writer(bridge, state)

    # Force _call_llm to throw on every call
    async def exploding_llm(messages, tools):
        raise RuntimeError("LLM exploded!")

    writer._call_llm = exploding_llm

    from pipecat.frames.frames import TranscriptionFrame, InterimTranscriptionFrame

    # Spy on push_frame at the class level; restore afterwards.
    original_push = type(writer).push_frame
    push_calls: list[Any] = []

    async def spy_push(self_inner, frame, direction=FrameDirection.DOWNSTREAM):
        push_calls.append(frame)

    type(writer).push_frame = spy_push

    try:
        interim = InterimTranscriptionFrame(text="hello", user_id="u1", timestamp="t")
        await writer.process_frame(interim, FrameDirection.DOWNSTREAM)

        final = TranscriptionFrame(text="hello world", user_id="u1", timestamp="t")
        await writer.process_frame(final, FrameDirection.DOWNSTREAM)

        # Wait for fire-and-forget tasks to run (they will error internally but
        # that must not prevent push_frame from having been called).
        await asyncio.sleep(0.1)

    finally:
        type(writer).push_frame = original_push

    # push_frame must have been called once per frame, regardless of LLM errors.
    assert len(push_calls) == 2, (
        f"Expected push_frame called 2×, got {len(push_calls)} calls"
    )


# ---------------------------------------------------------------------------
# 6. Phase 1 throttle: rapid duplicates are suppressed
# ---------------------------------------------------------------------------

async def test_phase1_throttle():
    """Phase 1 skips updates that arrive too fast with negligible text change."""
    bridge = FakeBridge()
    state = FakeState()
    writer = _make_writer(bridge, state)

    # Simulate rapid interim frames with tiny text changes
    await writer._phase1_live("hello")
    # Immediately after (within 70 ms), tiny change → should be throttled
    await writer._phase1_live("hello ")  # only 1 char delta

    # Only the first should have gone through (or at most 1 at this point)
    addmd_count = bridge.actions().count("addMarkdown")
    assert addmd_count <= 1, (
        f"Throttle failed: expected <=1 addMarkdown, got {addmd_count}"
    )

    # After enough time, the next push should go through
    writer._last_live_push_at -= 0.1  # simulate 100 ms elapsed
    await writer._phase1_live("hello world")
    addmd_count_after = bridge.actions().count("addMarkdown")
    assert addmd_count_after >= 1, "Expected at least one addMarkdown after throttle window"


# ---------------------------------------------------------------------------
# 7. Non-blocking: InterimTranscriptionFrame always forwarded (simple check)
# ---------------------------------------------------------------------------

async def test_interim_frame_always_forwarded():
    """InterimTranscriptionFrame is forwarded even when bridge raises."""
    bridge = FakeBridge()
    state = FakeState()

    # Make bridge.send raise on every call
    async def bad_send(action, payload):
        raise ConnectionError("bridge down")

    bridge.send = bad_send

    writer = _make_writer(bridge, state)
    writer._llm_enabled = False  # disable Phase 2 to isolate Phase 1

    push_calls = []
    original_push = type(writer).push_frame

    async def spy_push(self_inner, frame, direction=FrameDirection.DOWNSTREAM):
        push_calls.append(frame)

    type(writer).push_frame = spy_push

    try:
        from pipecat.frames.frames import InterimTranscriptionFrame
        frame = InterimTranscriptionFrame(text="test", user_id="u", timestamp="t")
        await writer.process_frame(frame, FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.05)
    finally:
        type(writer).push_frame = original_push

    assert len(push_calls) == 1, (
        f"Expected push_frame called once for InterimFrame, got {len(push_calls)}"
    )

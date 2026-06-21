"""End-to-end integration test for the voice→whiteboard harness.

Drives BoardWriter across a multi-turn scenario using:
  - a MOCK LLM (_call_llm patched with canned tool_calls)
  - a FAKE bridge (records every {action, payload} posted)
  - a fakeredis-backed BoardState (real Redis data path, no real Redis daemon)

Scenario
--------
Turn 1:  Student talks about photosynthesis.
         LLM writes notes_phot under topic "photosynthesis".
         → Block notes_phot exists in state under topic "photosynthesis".
         → Active topic is "photosynthesis".

Turn 2:  Student continues photosynthesis.
         LLM reuses notes_phot (same topicId "photosynthesis").
         → notes_phot updated in place.
         → No Phase 3 triggered (topic unchanged).

Turn 3:  Student moves to cell respiration.
         LLM mints NEW topic "respiration" → prior topic "photosynthesis" seals.
         → Phase 3 consolidation fires for "photosynthesis":
             writes consolidated_photosynthesis BEFORE removing notes_phot.
         → Final state: consolidated_photosynthesis present, notes_phot absent.
         → Writes always precede removes in Phase 3 bridge output.

The test is fully offline — no network, no real Redis, no real LLM.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any
from unittest.mock import AsyncMock

import pytest
import fakeredis.aioredis as fake_aioredis

from board_state import BoardState
from board_writer import BoardWriter, _sort_writes_before_removes, _CREATE_TOOLS, _REMOVE_TOOLS


# ---------------------------------------------------------------------------
# Fake bridge — records every (action, payload) posted, in order.
# ---------------------------------------------------------------------------


class FakeBridge:
    """Records every {action, payload} posted to the whiteboard bridge."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, action: str, payload: dict[str, Any]) -> None:
        self.sent.append({"action": action, "payload": payload})

    def actions(self) -> list[str]:
        return [s["action"] for s in self.sent]

    def clear(self) -> None:
        self.sent.clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_tc(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Build an OpenAI-style tool_call dict."""
    return {
        "id": f"call_{name}",
        "type": "function",
        "function": {"name": name, "arguments": arguments},
    }


async def _make_writer(session: str = "integration-test") -> tuple[BoardWriter, FakeBridge, BoardState]:
    """Construct a BoardWriter with a fakeredis BoardState and FakeBridge."""
    redis_client = fake_aioredis.FakeRedis(decode_responses=True)
    state = BoardState(session=session, client=redis_client)
    bridge = FakeBridge()

    writer = BoardWriter(session=session, bridge=bridge, state=state)
    # Force LLM-enabled so phases 2 & 3 run (patched _call_llm per test).
    writer._llm_enabled = True
    writer._config = {
        "base_url": "http://fake-llm/v1",
        "api_key": "fake",
        "model": "fake-model",
    }

    # Patch push_frame so the writer doesn't need a real pipecat pipeline.
    from pipecat.processors.frame_processor import FrameDirection
    async def _noop_push(self_inner, frame, direction=FrameDirection.DOWNSTREAM):
        pass
    type(writer).push_frame = _noop_push

    return writer, bridge, state


# ---------------------------------------------------------------------------
# FIX 2 — unit test: _sort_writes_before_removes
# ---------------------------------------------------------------------------


def test_sort_writes_before_removes_reversed_input():
    """A reversed LLM response (removes first) must still execute writes first."""
    remove_call = _make_tc("remove_block", {"id": "frag_0"})
    write_call = _make_tc("write_notes", {
        "id": "consolidated_photo",
        "topicId": "photosynthesis",
        "title": "Photosynthesis",
        "markdown": "Clean synthesis.",
    })

    # Feed removes-first (the bug this guards against).
    ordered = _sort_writes_before_removes([remove_call, write_call])

    assert len(ordered) == 2
    first_name = ordered[0]["function"]["name"]
    second_name = ordered[1]["function"]["name"]
    assert first_name in _CREATE_TOOLS, f"Expected a create tool first, got {first_name!r}"
    assert second_name in _REMOVE_TOOLS, f"Expected a remove tool second, got {second_name!r}"


def test_sort_writes_before_removes_preserves_relative_order():
    """Within each group (creates / removes / others) relative order is preserved."""
    tc1 = _make_tc("write_notes", {"id": "a", "topicId": "t", "title": "A", "markdown": ""})
    tc2 = _make_tc("remove_block", {"id": "x"})
    tc3 = _make_tc("make_flowchart", {"id": "b", "topicId": "t", "title": "B", "steps": []})
    tc4 = _make_tc("remove_block", {"id": "y"})

    # Input order: write, remove, write, remove → creates should precede removes,
    # but write A before flowchart B, and remove X before remove Y.
    ordered = _sort_writes_before_removes([tc1, tc2, tc3, tc4])
    names = [tc["function"]["name"] for tc in ordered]

    # All creates come before all removes.
    create_indices = [i for i, n in enumerate(names) if n in _CREATE_TOOLS]
    remove_indices = [i for i, n in enumerate(names) if n in _REMOVE_TOOLS]
    assert max(create_indices) < min(remove_indices), (
        f"A create came after a remove: {names}"
    )

    # Relative order within creates preserved: A before B.
    assert names.index("write_notes") < names.index("make_flowchart")
    # Relative order within removes preserved: X (index 0 in removes) before Y.
    remove_block_calls = [tc for tc in ordered if tc["function"]["name"] == "remove_block"]
    assert remove_block_calls[0]["function"]["arguments"]["id"] == "x"
    assert remove_block_calls[1]["function"]["arguments"]["id"] == "y"


# ---------------------------------------------------------------------------
# Integration scenario — multi-turn
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_integration_multi_turn():
    """Full multi-turn harness integration: topic A → continue A → new topic B."""
    writer, bridge, state = await _make_writer()

    # -----------------------------------------------------------------------
    # TURN 1: photosynthesis (new topic)
    # -----------------------------------------------------------------------
    turn1_calls = [
        _make_tc("write_notes", {
            "id": "notes_phot",
            "topicId": "photosynthesis",
            "title": "Photosynthesis",
            "markdown": "## Photosynthesis\nLight + CO2 → sugar.",
        }),
    ]
    writer._call_llm = AsyncMock(return_value=turn1_calls)

    await writer._do_phase2("So photosynthesis takes light and CO2 and makes sugar...")

    # Block should exist under topic photosynthesis.
    blk = await state.get_block("notes_phot")
    assert blk is not None, "notes_phot should exist after turn 1"
    assert blk["topicId"] == "photosynthesis"

    # Active topic set.
    assert writer._active_topic == "photosynthesis"
    redis_topic = await state.get_active_topic()
    assert redis_topic == "photosynthesis"

    # -----------------------------------------------------------------------
    # TURN 2: continue photosynthesis (same topicId → no Phase 3)
    # -----------------------------------------------------------------------
    bridge.clear()
    phase3_calls: list[str] = []
    original_do_phase3 = writer._do_phase3

    async def tracking_do_phase3(sealed_topic: str) -> None:
        phase3_calls.append(sealed_topic)
        # Still run the original so we test actual consolidation in turn 3.
        await original_do_phase3(sealed_topic)

    writer._do_phase3 = tracking_do_phase3

    turn2_calls = [
        _make_tc("write_notes", {
            "id": "notes_phot",          # same id → in-place update
            "topicId": "photosynthesis", # same topic
            "title": "Photosynthesis",
            "markdown": "## Photosynthesis\nLight + CO2 → sugar.\nAlso produces O2.",
        }),
    ]
    writer._call_llm = AsyncMock(return_value=turn2_calls)

    await writer._do_phase2("And photosynthesis also produces oxygen as a byproduct...")

    # Block updated in-place.
    blk2 = await state.get_block("notes_phot")
    assert blk2 is not None
    assert "O2" in blk2["content"], "content should reflect turn-2 update"

    # No Phase 3 fired for photosynthesis yet (topic unchanged).
    assert "photosynthesis" not in phase3_calls, (
        "Phase 3 should NOT fire when topic continues"
    )

    # -----------------------------------------------------------------------
    # TURN 3: new topic "respiration" → photosynthesis seals → Phase 3
    # -----------------------------------------------------------------------
    bridge.clear()

    # Phase 3 LLM: consolidate photosynthesis into one flowchart + remove fragment.
    phase3_tool_calls = [
        _make_tc("make_flowchart", {
            "id": "consolidated_photosynthesis",
            "topicId": "photosynthesis",
            "title": "Photosynthesis Process",
            "steps": [
                {"id": "s1", "label": "Light absorption"},
                {"id": "s2", "label": "CO2 fixation"},
                {"id": "s3", "label": "O2 + sugar output"},
            ],
        }),
        _make_tc("remove_block", {"id": "notes_phot"}),
    ]

    # Phase 2 LLM: new topic respiration.
    turn3_calls = [
        _make_tc("write_notes", {
            "id": "notes_resp",
            "topicId": "respiration",
            "title": "Cell Respiration",
            "markdown": "## Cell Respiration\nGlucose → ATP + CO2.",
        }),
    ]

    # _call_llm is called twice: once for Phase 2 (turn 3), once for Phase 3.
    call_count = 0
    async def llm_router(messages, tools):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return turn3_calls       # Phase 2: new topic
        else:
            return phase3_tool_calls  # Phase 3: consolidate photosynthesis

    writer._call_llm = llm_router

    await writer._do_phase2("Now let me explain cell respiration — glucose breaks down into ATP...")

    # Wait for spawned Phase 3 task to run.
    await asyncio.sleep(0.1)

    # Phase 3 should have fired for photosynthesis.
    assert "photosynthesis" in phase3_calls, (
        f"Phase 3 not triggered for photosynthesis; calls={phase3_calls}"
    )

    # Active topic is now respiration.
    assert writer._active_topic == "respiration"

    # Consolidated artifact should exist.
    consolidated = await state.get_block("consolidated_photosynthesis")
    assert consolidated is not None, "consolidated_photosynthesis block should exist"
    assert consolidated["type"] == "flowchart"

    # Original fragment should be gone.
    assert await state.get_block("notes_phot") is None, (
        "notes_phot fragment should have been removed by Phase 3"
    )

    # New respiration block should exist.
    resp_blk = await state.get_block("notes_resp")
    assert resp_blk is not None
    assert resp_blk["topicId"] == "respiration"

    # -----------------------------------------------------------------------
    # ORDERING INVARIANT: the consolidated artifact write must appear BEFORE
    # any removeNode that deletes fragments, within the full bridge log.
    # Find the index of addFlowchart (the Phase 3 write) and the LAST
    # removeNode that deleted notes_phot (the fragment removal from Phase 3).
    # -----------------------------------------------------------------------
    all_actions = bridge.actions()
    all_sent = bridge.sent

    # Find when addFlowchart for consolidated_photosynthesis was sent.
    flowchart_idx = next(
        (i for i, s in enumerate(all_sent) if s["action"] == "addFlowchart"),
        None,
    )
    # Find when removeNode for notes_phot was sent.
    remove_phot_idx = next(
        (i for i, s in enumerate(all_sent)
         if s["action"] == "removeNode" and s["payload"].get("id") == "notes_phot"),
        None,
    )

    assert flowchart_idx is not None, f"No addFlowchart in bridge output: {all_actions}"
    assert remove_phot_idx is not None, (
        f"No removeNode for notes_phot in bridge output: {all_actions}"
    )
    assert flowchart_idx < remove_phot_idx, (
        f"Phase 3 write (addFlowchart idx={flowchart_idx}) came AFTER "
        f"remove (removeNode[notes_phot] idx={remove_phot_idx}): {all_actions}"
    )


@pytest.mark.asyncio
async def test_integration_phase3_reversed_llm_output():
    """Phase 3 must write before removing even if the LLM emits removes first."""
    writer, bridge, state = await _make_writer(session="reverse-test")

    # Pre-populate a topic with fragments.
    for i in range(2):
        await state.upsert_block({
            "id": f"frag_{i}",
            "topicId": "bio",
            "type": "notes",
            "title": f"Fragment {i}",
            "content": f"Content {i}",
            "shapeIds": [f"frag_{i}"],
            "updatedAt": time.time(),
        })

    # LLM returns removes BEFORE the consolidated write (the bug this guards).
    reversed_calls = [
        _make_tc("remove_block", {"id": "frag_0"}),   # ← remove first (bad LLM)
        _make_tc("remove_block", {"id": "frag_1"}),
        _make_tc("write_notes", {                      # ← write last (bad LLM)
            "id": "consolidated_bio",
            "topicId": "bio",
            "title": "Biology",
            "markdown": "Synthesis of bio topic.",
        }),
    ]
    writer._call_llm = AsyncMock(return_value=reversed_calls)

    await writer._do_phase3("bio")

    actions = bridge.actions()

    # addMarkdown must appear BEFORE any removeNode in the bridge output.
    write_idx = next((i for i, a in enumerate(actions) if a == "addMarkdown"), None)
    remove_indices = [i for i, a in enumerate(actions) if a == "removeNode"]

    assert write_idx is not None, f"No addMarkdown in bridge output: {actions}"
    assert remove_indices, f"No removeNode in bridge output: {actions}"
    assert write_idx < min(remove_indices), (
        f"addMarkdown (idx={write_idx}) came AFTER removeNode (indices={remove_indices}): {actions}"
    )

    # Consolidated block exists; fragments removed.
    assert await state.get_block("consolidated_bio") is not None
    assert await state.get_block("frag_0") is None
    assert await state.get_block("frag_1") is None

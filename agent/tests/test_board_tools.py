"""Tests for agent/board_tools.py (M2).

Uses a FakeBridge (records sent {action,payload}) and a FakeState (in-memory
dict implementing the M1 BoardState duck-typed interface). No real Redis or
HTTP needed.

pytest-asyncio: async tests are marked individually with @pytest.mark.asyncio.
The module-level pytestmark is intentionally NOT set to asyncio — that would
emit PytestWarning for the synchronous schema-check tests at the top.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
import pytest_asyncio

from board_tools import (
    TOOL_SCHEMAS,
    BridgePoster,
    execute_tool_call,
    resolve_placement,
    _BLOCK_W,
    _BLOCK_H,
    _GAP,
    _ORIGIN_X,
    _ORIGIN_Y,
    _COL_COUNT,
)

# ---------------------------------------------------------------------------
# Fake helpers
# ---------------------------------------------------------------------------


class FakeBridge:
    """Records every (action, payload) pair posted."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, action: str, payload: dict[str, Any]) -> None:
        self.sent.append({"action": action, "payload": payload})

    def last(self) -> dict[str, Any]:
        return self.sent[-1]

    def actions(self) -> list[str]:
        return [s["action"] for s in self.sent]


class FakeState:
    """In-memory BlockRecord store implementing the M1 duck-typed interface."""

    def __init__(self) -> None:
        self._blocks: dict[str, dict[str, Any]] = {}

    async def upsert_block(self, rec: dict[str, Any]) -> None:
        block_id = rec["id"]
        self._blocks[block_id] = dict(rec)

    async def get_block(self, block_id: str) -> dict[str, Any] | None:
        return self._blocks.get(block_id)

    async def remove_block(self, block_id: str) -> None:
        self._blocks.pop(block_id, None)

    async def get_state_summary(self) -> list[dict[str, Any]]:
        return [
            {
                "id": rec["id"],
                "topicId": rec.get("topicId", ""),
                "type": rec.get("type", ""),
                "title": rec.get("title", ""),
                "summary": "",
                "bbox": rec.get("bbox") or {"x": 0, "y": 0, "w": 0, "h": 0},
            }
            for rec in self._blocks.values()
        ]

    async def update_geometry(self, block_id: str, bbox: dict[str, float]) -> None:
        if block_id in self._blocks:
            self._blocks[block_id]["bbox"] = bbox


# ---------------------------------------------------------------------------
# Helper: build an OpenAI-style tool_call dict
# ---------------------------------------------------------------------------


def _make_tool_call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "call_test",
        "type": "function",
        "function": {"name": name, "arguments": arguments},
    }


# ---------------------------------------------------------------------------
# TOOL_SCHEMAS sanity checks
# ---------------------------------------------------------------------------


def test_tool_schemas_count():
    assert len(TOOL_SCHEMAS) == 16


def test_tool_schemas_names():
    expected = {
        "write_notes", "make_flowchart", "make_mindmap", "make_diagram",
        "add_image", "highlight", "remove_block", "clear_board",
        # 8 new tools
        "append_notes", "write_explanation", "append_explanation",
        "add_sticky", "add_node", "connect_nodes", "update_node", "move_block",
    }
    actual = {s["function"]["name"] for s in TOOL_SCHEMAS}
    assert actual == expected


def test_tool_schemas_all_have_required_keys():
    for schema in TOOL_SCHEMAS:
        assert schema["type"] == "function"
        fn = schema["function"]
        assert "name" in fn
        assert "description" in fn
        assert "parameters" in fn


def test_tool_schemas_anchor_optional():
    """write_notes, make_flowchart, make_mindmap, add_image should have anchor as optional."""
    anchor_tools = {"write_notes", "make_flowchart", "make_mindmap", "make_diagram", "add_image"}
    for schema in TOOL_SCHEMAS:
        fn = schema["function"]
        if fn["name"] in anchor_tools:
            params = fn["parameters"]
            assert "anchor" in params["properties"]
            assert "anchor" not in params.get("required", [])


def test_tool_schemas_topicId_required_on_create_tools():
    """write_notes, make_flowchart, make_mindmap, add_image must require topicId."""
    create_tools = {"write_notes", "make_flowchart", "make_mindmap", "make_diagram", "add_image"}
    for schema in TOOL_SCHEMAS:
        fn = schema["function"]
        if fn["name"] in create_tools:
            params = fn["parameters"]
            assert "topicId" in params["properties"], (
                f"{fn['name']} is missing topicId property"
            )
            assert "topicId" in params.get("required", []), (
                f"{fn['name']} must list topicId in required"
            )


# ---------------------------------------------------------------------------
# write_notes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_notes_sends_addMarkdown():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("write_notes", {
        "id": "block_phot",
        "title": "Photosynthesis",
        "markdown": "# Photosynthesis\n\nLight → sugar.",
    })
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="topic1")

    assert result["ok"] is True
    assert result["action"] == "addMarkdown"
    assert len(bridge.sent) == 1
    pkt = bridge.sent[0]
    assert pkt["action"] == "addMarkdown"
    assert pkt["payload"]["id"] == "block_phot"
    assert "Light" in pkt["payload"]["markdown"]


@pytest.mark.asyncio
async def test_write_notes_upserts_state():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("write_notes", {
        "id": "notes_1",
        "title": "Newton's Laws",
        "markdown": "1. F=ma",
    })
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="physics")

    block = await state.get_block("notes_1")
    assert block is not None
    assert block["type"] == "notes"
    assert block["topicId"] == "physics"
    assert block["title"] == "Newton's Laws"
    assert block["shapeIds"] == ["notes_1"]


@pytest.mark.asyncio
async def test_write_notes_upsert_reuses_position():
    """Calling write_notes twice with the same id should reuse the stored position."""
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("write_notes", {
        "id": "persistent",
        "title": "T",
        "markdown": "v1",
    })
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    first_pos = bridge.sent[0]["payload"]["position"]

    # Simulate geometry write-back so reuse path is exercised.
    await state.update_geometry("persistent", {
        "x": first_pos["x"], "y": first_pos["y"], "w": _BLOCK_W, "h": _BLOCK_H
    })

    tc2 = _make_tool_call("write_notes", {
        "id": "persistent",
        "title": "T",
        "markdown": "v2",
    })
    await execute_tool_call(tc2, state=state, bridge=bridge, active_topic="t")
    second_pos = bridge.sent[1]["payload"]["position"]

    assert first_pos == second_pos


# ---------------------------------------------------------------------------
# make_flowchart
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_make_flowchart_sends_addFlowchart():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("make_flowchart", {
        "id": "fc_cellular",
        "title": "Cellular Respiration",
        "steps": [
            {"id": "step_glycolysis", "label": "Glycolysis"},
            {"id": "step_krebs", "label": "Krebs Cycle"},
            {"id": "step_etc", "label": "Electron Transport"},
        ],
    })
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="bio")

    assert result["ok"] is True
    assert result["action"] == "addFlowchart"
    pkt = bridge.sent[0]
    assert pkt["action"] == "addFlowchart"
    assert pkt["payload"]["id"] == "fc_cellular"
    assert len(pkt["payload"]["steps"]) == 3


@pytest.mark.asyncio
async def test_make_flowchart_tracks_step_ids_as_shape_ids():
    """shapeIds must be the step ids so remove_block can delete each shape."""
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("make_flowchart", {
        "id": "fc_test",
        "title": "Test",
        "steps": [
            {"id": "s1", "label": "Start"},
            {"id": "s2", "label": "End"},
        ],
    })
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    block = await state.get_block("fc_test")
    assert block["shapeIds"] == ["s1", "s2"]
    assert result_from_block(block)["type"] == "flowchart"


def result_from_block(block: dict) -> dict:
    return block  # just a helper alias for clarity


# ---------------------------------------------------------------------------
# make_mindmap
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_make_mindmap_sends_addMindMap():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("make_mindmap", {
        "id": "mm_dna",
        "center": "DNA",
        "branches": [
            {"id": "br_replication", "label": "Replication"},
            {"id": "br_transcription", "label": "Transcription"},
            {"id": "br_translation", "label": "Translation"},
        ],
    })
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="bio")

    assert result["ok"] is True
    assert result["action"] == "addMindMap"
    pkt = bridge.sent[0]
    assert pkt["action"] == "addMindMap"
    assert pkt["payload"]["centerLabel"] == "DNA"
    assert len(pkt["payload"]["branches"]) == 3


@pytest.mark.asyncio
async def test_make_mindmap_shape_ids_include_center_and_branches():
    """Center shape id = block_id + '__center'; branch ids = branch['id'] values."""
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("make_mindmap", {
        "id": "mm_solar",
        "center": "Solar System",
        "branches": [
            {"id": "br_mercury", "label": "Mercury"},
            {"id": "br_venus", "label": "Venus"},
        ],
    })
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="astro")

    block = await state.get_block("mm_solar")
    assert block["shapeIds"] == ["mm_solar__center", "br_mercury", "br_venus"]


# ---------------------------------------------------------------------------
# add_image (stub)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_image_sends_requestImage_only():
    """v1 stub: only requestImage, no resolveImage."""
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("add_image", {
        "id": "img_cell",
        "prompt": "A diagram of a plant cell with labeled organelles",
        "caption": "Plant cell",
    })
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="bio")

    assert result["ok"] is True
    assert result["action"] == "requestImage"
    assert bridge.actions() == ["requestImage"]  # no resolveImage
    assert bridge.sent[0]["payload"]["prompt"] == "A diagram of a plant cell with labeled organelles"


@pytest.mark.asyncio
async def test_add_image_upserts_state():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("add_image", {
        "id": "img_atm",
        "prompt": "Atmosphere layers diagram",
    })
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="earth")

    block = await state.get_block("img_atm")
    assert block["type"] == "image"
    assert block["shapeIds"] == ["img_atm"]


# ---------------------------------------------------------------------------
# highlight
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_highlight_sends_highlightNode():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("highlight", {"id": "notes_kinetic"})
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="phys")

    assert result["ok"] is True
    assert bridge.actions() == ["highlightNode"]
    assert bridge.sent[0]["payload"]["id"] == "notes_kinetic"


@pytest.mark.asyncio
async def test_highlight_does_not_write_state():
    """highlight should never write to state (no upsert_block call)."""
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("highlight", {"id": "some_block"})
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    # State should remain empty.
    assert state._blocks == {}


# ---------------------------------------------------------------------------
# remove_block
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_remove_block_sends_removeNode_per_child():
    """remove_block must send one removeNode per child shape id."""
    bridge = FakeBridge()
    state = FakeState()

    # Pre-populate a flowchart block with 3 child shapes.
    await state.upsert_block({
        "id": "fc_krebs",
        "topicId": "bio",
        "type": "flowchart",
        "title": "Krebs",
        "content": "",
        "bbox": {"x": 100, "y": 100, "w": 480, "h": 320},
        "shapeIds": ["step_a", "step_b", "step_c"],
        "updatedAt": time.time(),
    })

    tc = _make_tool_call("remove_block", {"id": "fc_krebs"})
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="bio")

    assert result["ok"] is True
    assert bridge.actions() == ["removeNode", "removeNode", "removeNode"]
    removed_ids = {s["payload"]["id"] for s in bridge.sent}
    assert removed_ids == {"step_a", "step_b", "step_c"}


@pytest.mark.asyncio
async def test_remove_block_removes_from_state():
    bridge = FakeBridge()
    state = FakeState()

    await state.upsert_block({
        "id": "notes_x",
        "topicId": "t",
        "type": "notes",
        "title": "X",
        "content": "",
        "bbox": {"x": 0, "y": 0, "w": 480, "h": 320},
        "shapeIds": ["notes_x"],
        "updatedAt": time.time(),
    })

    tc = _make_tool_call("remove_block", {"id": "notes_x"})
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    assert await state.get_block("notes_x") is None


@pytest.mark.asyncio
async def test_remove_block_mindmap_children():
    """remove_block on a mind map must remove center + all branch shapes."""
    bridge = FakeBridge()
    state = FakeState()

    await state.upsert_block({
        "id": "mm_planets",
        "topicId": "astro",
        "type": "mindmap",
        "title": "Planets",
        "content": "",
        "bbox": {"x": 200, "y": 200, "w": 480, "h": 320},
        "shapeIds": ["mm_planets__center", "br_earth", "br_mars"],
        "updatedAt": time.time(),
    })

    tc = _make_tool_call("remove_block", {"id": "mm_planets"})
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="astro")

    removed_ids = {s["payload"]["id"] for s in bridge.sent}
    assert removed_ids == {"mm_planets__center", "br_earth", "br_mars"}
    assert await state.get_block("mm_planets") is None


@pytest.mark.asyncio
async def test_remove_block_unknown_id_sends_one_removeNode():
    """If the block isn't in state, fall back to one removeNode with the block id."""
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("remove_block", {"id": "ghost_block"})
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="t")

    assert result["ok"] is True
    assert bridge.actions() == ["removeNode"]
    assert bridge.sent[0]["payload"]["id"] == "ghost_block"


# ---------------------------------------------------------------------------
# clear_board
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clear_board_sends_clearBoard():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("clear_board", {})
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="any")

    assert result["ok"] is True
    assert bridge.actions() == ["clearBoard"]


# ---------------------------------------------------------------------------
# resolve_placement
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_placement_reuses_stored_position():
    state = FakeState()
    await state.upsert_block({
        "id": "blk_stored",
        "topicId": "t",
        "type": "notes",
        "title": "",
        "content": "",
        "bbox": {"x": 500, "y": 250, "w": 480, "h": 320},
        "shapeIds": [],
        "updatedAt": time.time(),
    })

    pos = await resolve_placement(state, "blk_stored", None)
    assert pos == {"x": 500.0, "y": 250.0}


@pytest.mark.asyncio
async def test_resolve_placement_anchor_near():
    state = FakeState()
    await state.upsert_block({
        "id": "blk_ref",
        "topicId": "t",
        "type": "notes",
        "title": "",
        "content": "",
        "bbox": {"x": 100, "y": 100, "w": 480, "h": 320},
        "shapeIds": [],
        "updatedAt": time.time(),
    })

    pos = await resolve_placement(
        state, "blk_new",
        anchor={"near": "blk_ref", "dir": "right"},
    )
    # Should be 100 + 480 + 40 = 620 for x, 100 for y.
    assert pos["x"] == pytest.approx(100 + _BLOCK_W + _GAP)
    assert pos["y"] == pytest.approx(100)


@pytest.mark.asyncio
async def test_resolve_placement_anchor_below():
    state = FakeState()
    await state.upsert_block({
        "id": "blk_top",
        "topicId": "t",
        "type": "notes",
        "title": "",
        "content": "",
        "bbox": {"x": 200, "y": 300, "w": 480, "h": 320},
        "shapeIds": [],
        "updatedAt": time.time(),
    })

    pos = await resolve_placement(
        state, "blk_below",
        anchor={"near": "blk_top", "dir": "below"},
    )
    assert pos["x"] == pytest.approx(200)
    assert pos["y"] == pytest.approx(300 + _BLOCK_H + _GAP)


@pytest.mark.asyncio
async def test_resolve_placement_grid_packing_no_overlap():
    """Grid packing: placing N+1 blocks should produce non-overlapping positions."""
    state = FakeState()
    placed: list[dict] = []

    block_count = 5
    for i in range(block_count):
        bid = f"blk_{i}"
        pos = await resolve_placement(state, bid, None)

        # Verify no overlap with any previously placed block.
        candidate = {"x": pos["x"], "y": pos["y"], "w": float(_BLOCK_W), "h": float(_BLOCK_H)}
        for prev in placed:
            x1 = candidate["x"]
            y1 = candidate["y"]
            x2 = x1 + candidate["w"]
            y2 = y1 + candidate["h"]
            px2 = prev["x"] + prev["w"]
            py2 = prev["y"] + prev["h"]
            overlapping = x1 < px2 and x2 > prev["x"] and y1 < py2 and y2 > prev["y"]
            assert not overlapping, f"Block {i} overlaps a previous block"

        # Register in state for the next iteration.
        await state.upsert_block({
            "id": bid,
            "topicId": "t",
            "type": "notes",
            "title": "",
            "content": "",
            "bbox": candidate,
            "shapeIds": [],
            "updatedAt": time.time(),
        })
        placed.append(candidate)


@pytest.mark.asyncio
async def test_resolve_placement_avoids_overlap_with_filled_row():
    """The lattice packer must place a new block where it overlaps nothing on the
    board (exact coords are an implementation detail of the lattice)."""
    from board_tools import _overlaps

    state = FakeState()
    filled = [
        {
            "x": float(_ORIGIN_X + i * (_BLOCK_W + _GAP)),
            "y": float(_ORIGIN_Y),
            "w": float(_BLOCK_W),
            "h": float(_BLOCK_H),
        }
        for i in range(_COL_COUNT)
    ]
    for i, bbox in enumerate(filled):
        await state.upsert_block({
            "id": f"row0_{i}", "topicId": "t", "type": "notes",
            "title": "", "content": "", "bbox": bbox, "shapeIds": [],
            "updatedAt": time.time(),
        })

    pos = await resolve_placement(state, "new_block", None)
    new_rect = {"x": pos["x"], "y": pos["y"], "w": float(_BLOCK_W), "h": float(_BLOCK_H)}
    assert not _overlaps(new_rect, filled)


@pytest.mark.asyncio
async def test_resolve_placement_reserves_real_size():
    """A tall artifact's estimated size must push the next block clear of it."""
    from board_tools import _overlaps

    state = FakeState()
    # A tall flowchart-like block already on the board.
    tall = {"x": float(_ORIGIN_X), "y": float(_ORIGIN_Y), "w": 320.0, "h": 1200.0}
    await state.upsert_block({
        "id": "tall", "topicId": "t", "type": "flowchart",
        "title": "", "content": "", "bbox": tall, "shapeIds": [],
        "updatedAt": time.time(),
    })

    pos = await resolve_placement(state, "next", None, size={"w": 480.0, "h": 320.0})
    new_rect = {"x": pos["x"], "y": pos["y"], "w": 480.0, "h": 320.0}
    assert not _overlaps(new_rect, [tall])


# ---------------------------------------------------------------------------
# Unknown tool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_tool_returns_ok_false():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("nonexistent_tool", {})
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="t")

    assert result["ok"] is False
    assert "nonexistent_tool" in result["tool"]


# ---------------------------------------------------------------------------
# JSON string arguments (OpenAI often sends arguments as a JSON string)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_arguments_as_json_string():
    import json
    bridge = FakeBridge()
    state = FakeState()

    tc = {
        "id": "call_str",
        "type": "function",
        "function": {
            "name": "write_notes",
            "arguments": json.dumps({
                "id": "str_block",
                "title": "String args",
                "markdown": "Parsed from string.",
            }),
        },
    }
    result = await execute_tool_call(tc, state=state, bridge=bridge,
                                     active_topic="t")

    assert result["ok"] is True
    assert bridge.sent[0]["payload"]["markdown"] == "Parsed from string."


# ---------------------------------------------------------------------------
# append_notes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_append_notes_sends_appendMarkdown():
    bridge = FakeBridge()
    state = FakeState()

    # Pre-populate a notes block so append has something to attach to.
    await state.upsert_block({
        "id": "notes_append",
        "topicId": "t",
        "type": "notes",
        "title": "T",
        "content": "existing",
        "bbox": {"x": 100, "y": 100, "w": 480, "h": 320},
        "shapeIds": ["notes_append"],
        "updatedAt": time.time(),
    })

    tc = _make_tool_call("append_notes", {"id": "notes_append", "markdown": "## More\n\nAppended."})
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    assert result["ok"] is True
    assert result["action"] == "appendMarkdown"
    pkt = bridge.last()
    assert pkt["action"] == "appendMarkdown"
    assert pkt["payload"]["id"] == "notes_append"
    assert "Appended" in pkt["payload"]["markdown"]


@pytest.mark.asyncio
async def test_append_notes_updates_state_content():
    bridge = FakeBridge()
    state = FakeState()

    await state.upsert_block({
        "id": "notes_grow",
        "topicId": "t",
        "type": "notes",
        "title": "T",
        "content": "part1",
        "bbox": {"x": 0, "y": 0, "w": 480, "h": 320},
        "shapeIds": ["notes_grow"],
        "updatedAt": time.time(),
    })

    tc = _make_tool_call("append_notes", {"id": "notes_grow", "markdown": "part2"})
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    block = await state.get_block("notes_grow")
    assert block is not None
    assert "part1" in block["content"]
    assert "part2" in block["content"]


# ---------------------------------------------------------------------------
# write_explanation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_explanation_sends_addExplanation():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("write_explanation", {"id": "exp_osmosis", "text": "Osmosis is water movement."})
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="bio")

    assert result["ok"] is True
    assert result["action"] == "addExplanation"
    pkt = bridge.last()
    assert pkt["action"] == "addExplanation"
    assert pkt["payload"]["id"] == "exp_osmosis"
    assert pkt["payload"]["text"] == "Osmosis is water movement."


@pytest.mark.asyncio
async def test_write_explanation_upserts_state():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("write_explanation", {
        "id": "exp_cell",
        "text": "The cell is the basic unit.",
        "w": 350,
        "h": 200,
    })
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="bio")

    block = await state.get_block("exp_cell")
    assert block is not None
    assert block["type"] == "explanation"
    assert block["shapeIds"] == ["exp_cell"]
    # w/h from args should appear in bbox
    assert block["bbox"]["w"] == 350
    assert block["bbox"]["h"] == 200


# ---------------------------------------------------------------------------
# append_explanation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_append_explanation_sends_appendToExplanation():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("append_explanation", {"id": "exp_dna", "moreText": "...and it carries genes."})
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="bio")

    assert result["ok"] is True
    assert result["action"] == "appendToExplanation"
    pkt = bridge.last()
    assert pkt["action"] == "appendToExplanation"
    assert pkt["payload"]["id"] == "exp_dna"
    assert pkt["payload"]["moreText"] == "...and it carries genes."


# ---------------------------------------------------------------------------
# add_sticky
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_sticky_sends_addNote():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("add_sticky", {"id": "sticky_atp", "text": "ATP = energy currency", "color": "green"})
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="bio")

    assert result["ok"] is True
    assert result["action"] == "addNote"
    pkt = bridge.last()
    assert pkt["action"] == "addNote"
    assert pkt["payload"]["id"] == "sticky_atp"
    assert pkt["payload"]["text"] == "ATP = energy currency"
    assert pkt["payload"]["color"] == "green"


@pytest.mark.asyncio
async def test_add_sticky_upserts_state():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("add_sticky", {"id": "sticky_note1", "text": "Remember this!"})
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    block = await state.get_block("sticky_note1")
    assert block is not None
    assert block["type"] == "note"
    assert block["shapeIds"] == ["sticky_note1"]


# ---------------------------------------------------------------------------
# add_node (both kinds)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_node_mindmap_sends_addMindMapNode():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("add_node", {
        "id": "mm_center",
        "label": "Cell Biology",
        "kind": "mindMap",
    })
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="bio")

    assert result["ok"] is True
    assert result["action"] == "addMindMapNode"
    pkt = bridge.last()
    assert pkt["action"] == "addMindMapNode"
    assert pkt["payload"]["id"] == "mm_center"
    assert pkt["payload"]["label"] == "Cell Biology"
    assert "parentId" not in pkt["payload"]  # no parentId means home/center node


@pytest.mark.asyncio
async def test_add_node_mindmap_with_parent():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("add_node", {
        "id": "mm_branch1",
        "label": "Mitosis",
        "kind": "mindMap",
        "parentId": "mm_center",
    })
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="bio")

    assert result["ok"] is True
    pkt = bridge.last()
    assert pkt["payload"]["parentId"] == "mm_center"


@pytest.mark.asyncio
async def test_add_node_flow_sends_addFlowNode():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("add_node", {
        "id": "flow_step1",
        "label": "Glycolysis",
        "kind": "flow",
        "subtitle": "Breaks glucose",
    })
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="bio")

    assert result["ok"] is True
    assert result["action"] == "addFlowNode"
    pkt = bridge.last()
    assert pkt["action"] == "addFlowNode"
    assert pkt["payload"]["id"] == "flow_step1"
    assert pkt["payload"]["subtitle"] == "Breaks glucose"


@pytest.mark.asyncio
async def test_add_node_explicit_xy_used_directly():
    """Explicit x/y must be forwarded as-is into position, skipping resolve_placement."""
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("add_node", {
        "id": "node_placed",
        "label": "Placed",
        "kind": "flow",
        "x": 999,
        "y": 777,
    })
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    pos = bridge.last()["payload"]["position"]
    assert pos["x"] == 999.0
    assert pos["y"] == 777.0


@pytest.mark.asyncio
async def test_add_node_upserts_state():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("add_node", {
        "id": "node_state",
        "label": "Test",
        "kind": "mindMap",
    })
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    block = await state.get_block("node_state")
    assert block is not None
    assert block["shapeIds"] == ["node_state"]
    assert block["type"] == "mindMap"


# ---------------------------------------------------------------------------
# connect_nodes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_nodes_sends_connectNodes():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("connect_nodes", {"fromId": "node_a", "toId": "node_b", "label": "causes"})
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    assert result["ok"] is True
    assert result["action"] == "connectNodes"
    pkt = bridge.last()
    assert pkt["action"] == "connectNodes"
    assert pkt["payload"]["fromId"] == "node_a"
    assert pkt["payload"]["toId"] == "node_b"
    assert pkt["payload"]["label"] == "causes"


@pytest.mark.asyncio
async def test_connect_nodes_without_label():
    """label is optional; payload must not include it when absent."""
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("connect_nodes", {"fromId": "n1", "toId": "n2"})
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    assert result["ok"] is True
    pkt = bridge.last()
    assert "label" not in pkt["payload"]


@pytest.mark.asyncio
async def test_connect_nodes_does_not_write_state():
    """connect_nodes creates an edge; no block record should appear in state."""
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("connect_nodes", {"fromId": "x", "toId": "y"})
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    assert state._blocks == {}


# ---------------------------------------------------------------------------
# update_node
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_node_sends_updateNode():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("update_node", {"id": "node_x", "newLabel": "Revised Label"})
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    assert result["ok"] is True
    assert result["action"] == "updateNode"
    pkt = bridge.last()
    assert pkt["action"] == "updateNode"
    assert pkt["payload"]["id"] == "node_x"
    assert pkt["payload"]["newLabel"] == "Revised Label"


@pytest.mark.asyncio
async def test_update_node_updates_state_title():
    bridge = FakeBridge()
    state = FakeState()

    await state.upsert_block({
        "id": "node_upd",
        "topicId": "t",
        "type": "flow",
        "title": "Old",
        "content": "Old",
        "bbox": {"x": 0, "y": 0, "w": 180, "h": 60},
        "shapeIds": ["node_upd"],
        "updatedAt": time.time(),
    })

    tc = _make_tool_call("update_node", {"id": "node_upd", "newLabel": "New"})
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    block = await state.get_block("node_upd")
    assert block["title"] == "New"


# ---------------------------------------------------------------------------
# move_block
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_move_block_sends_moveShape():
    bridge = FakeBridge()
    state = FakeState()

    tc = _make_tool_call("move_block", {"id": "blk_move", "x": 500, "y": 300})
    result = await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    assert result["ok"] is True
    assert result["action"] == "moveShape"
    pkt = bridge.last()
    assert pkt["action"] == "moveShape"
    assert pkt["payload"]["id"] == "blk_move"
    assert pkt["payload"]["x"] == 500.0
    assert pkt["payload"]["y"] == 300.0


@pytest.mark.asyncio
async def test_move_block_updates_bbox_in_state():
    bridge = FakeBridge()
    state = FakeState()

    await state.upsert_block({
        "id": "blk_mv",
        "topicId": "t",
        "type": "notes",
        "title": "T",
        "content": "",
        "bbox": {"x": 100, "y": 100, "w": 480, "h": 320},
        "shapeIds": ["blk_mv"],
        "updatedAt": time.time(),
    })

    tc = _make_tool_call("move_block", {"id": "blk_mv", "x": 800, "y": 600})
    await execute_tool_call(tc, state=state, bridge=bridge, active_topic="t")

    block = await state.get_block("blk_mv")
    assert block["bbox"]["x"] == 800.0
    assert block["bbox"]["y"] == 600.0
    # Width/height should be preserved.
    assert block["bbox"]["w"] == 480
    assert block["bbox"]["h"] == 320

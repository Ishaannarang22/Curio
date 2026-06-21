"""Tests for agent/structuring_agent.py — router → renderer → replace.

Offline: _call_llm is monkeypatched per forced_tool, the bridge is a fake recorder,
and state is a real InMemoryBoardState. No network.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from board_state import InMemoryBoardState
from structuring_agent import StructuringAgent
from topic_tree import SealEvent

pytestmark = pytest.mark.asyncio


class FakeBridge:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, action: str, payload: dict[str, Any]) -> None:
        self.sent.append({"action": action, "payload": payload})

    async def aclose(self) -> None:
        pass

    def actions(self) -> list[str]:
        return [s["action"] for s in self.sent]

    def removed_ids(self) -> list[str]:
        return [s["payload"].get("id") for s in self.sent if s["action"] == "removeNode"]


def _router_call(needs: bool, fmt: str | None = None, reason: str = "r") -> list[dict[str, Any]]:
    args: dict[str, Any] = {"needs_restructure": needs, "reason": reason}
    if fmt:
        args["format"] = fmt
    return [{"id": "c", "type": "function", "function": {"name": "plan_structure", "arguments": json.dumps(args)}}]


def _render_call(tool: str, args: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"id": "c", "type": "function", "function": {"name": tool, "arguments": json.dumps(args)}}]


def _make_agent(bridge: FakeBridge, state: InMemoryBoardState) -> StructuringAgent:
    agent = StructuringAgent(session="test", state=state, bridge=bridge)
    # Force-enable with a fake config (the patched _call_llm ignores url/key).
    agent._enabled = True
    agent._config = {
        "base_url": "http://fake/v1", "api_key": "k",
        "router_model": "router", "render_model": "render",
    }
    return agent


def _script(agent: StructuringAgent, *, router, render) -> None:
    """Monkeypatch _call_llm to answer per forced_tool."""
    async def fake_call(model, messages, tools, *, forced_tool):
        if forced_tool == "plan_structure":
            return router
        return render
    agent._call_llm = fake_call  # type: ignore[assignment]


async def test_no_restructure_leaves_raw():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    await state.upsert_block({"id": "leaf-1", "topicId": "leaf-1", "type": "notes",
                              "title": "T", "content": "raw", "bbox": {"x": 100, "y": 100, "w": 480, "h": 200}})
    agent = _make_agent(bridge, state)
    _script(agent, router=_router_call(False), render=[])

    await agent._structure(SealEvent("leaf-1", "Topic", "leaf", "some short raw", "sibling"))

    # No artifact written, raw block untouched.
    assert bridge.actions() == []
    assert (await state.get_block("leaf-1"))["type"] == "notes"


async def test_leaf_seal_renders_and_replaces_raw():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    await state.upsert_block({"id": "leaf-1", "topicId": "leaf-1", "type": "notes",
                              "title": "T", "content": "raw", "bbox": {"x": 100, "y": 100, "w": 480, "h": 200}})
    agent = _make_agent(bridge, state)
    _script(
        agent,
        router=_router_call(True, "flowchart"),
        # Renderer returns the WRONG id on purpose — the agent must pin it to node id.
        render=_render_call("make_flowchart", {
            "id": "model-picked-something-else", "topicId": "x", "title": "Process",
            "steps": [{"id": "s1", "label": "A"}, {"id": "s2", "label": "B"}],
        }),
    )

    await agent._structure(SealEvent("leaf-1", "Process", "leaf", "first do A then B", "sibling"))

    # Flowchart written at the node's block id, then the leftover raw shape removed.
    assert "addFlowchart" in bridge.actions()
    block = await state.get_block("leaf-1")
    assert block["type"] == "flowchart"
    assert "leaf-1" in bridge.removed_ids()  # the raw markdown shape


async def test_parent_seal_merges_and_clears_children():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    # Parent raw + two provisional child artifacts already on the board.
    for bid, typ, shapes in [
        ("parent-1", "notes", ["parent-1"]),
        ("child-1", "flowchart", ["c1s1", "c1s2"]),
        ("child-2", "mindmap", ["child-2__center", "c2b1"]),
    ]:
        await state.upsert_block({"id": bid, "topicId": bid, "type": typ, "title": bid,
                                  "content": "", "bbox": {"x": 100, "y": 100, "w": 480, "h": 200},
                                  "shapeIds": shapes})
    agent = _make_agent(bridge, state)
    _script(
        agent,
        router=_router_call(True, "mindmap"),
        render=_render_call("make_mindmap", {
            "id": "x", "topicId": "x", "center": "Parent",
            "branches": [{"id": "b1", "label": "One"}, {"id": "b2", "label": "Two"}],
        }),
    )

    await agent._structure(
        SealEvent("parent-1", "Parent", "parent", "whole subtree raw", "ascend",
                  descendant_ids=["child-1", "child-2"])
    )

    # Consolidated mindmap at the parent block; children gone from state.
    assert "addMindMap" in bridge.actions()
    assert (await state.get_block("parent-1"))["type"] == "mindmap"
    assert await state.get_block("child-1") is None
    assert await state.get_block("child-2") is None


async def test_on_seal_enqueues_and_worker_drains():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    agent = _make_agent(bridge, state)
    _script(
        agent,
        router=_router_call(True, "diagram"),
        render=_render_call("make_diagram", {
            "id": "x", "topicId": "x", "title": "Rel",
            "nodes": [{"id": "n1", "label": "A"}, {"id": "n2", "label": "B"}],
            "edges": [{"fromId": "n1", "toId": "n2", "label": "links"}],
        }),
    )

    await agent.on_seal(SealEvent("leaf-9", "Rel", "leaf", "A relates to B", "sibling"))
    await agent._queue.join()  # let the background worker finish

    assert "addDiagram" in bridge.actions()
    assert (await state.get_block("leaf-9"))["type"] == "diagram"


async def test_disabled_agent_is_silent():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    agent = StructuringAgent(session="test", state=state, bridge=bridge)
    agent._enabled = False  # no key
    await agent.on_seal(SealEvent("leaf-1", "T", "leaf", "raw", "sibling"))
    assert bridge.actions() == []

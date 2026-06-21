"""Tests for agent/spawner_agent.py — decide → emit faithful margin visuals.

Offline: _call_llm is monkeypatched to answer the plan_support decider, the bridge is
a fake recorder, and state is a real InMemoryBoardState. No network.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from board_state import InMemoryBoardState
from spawner_agent import SpawnerAgent
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

    def ids_for(self, action: str) -> list[str]:
        return [s["payload"].get("id") for s in self.sent if s["action"] == action]

    def payload_for(self, action: str) -> dict[str, Any]:
        return next(s["payload"] for s in self.sent if s["action"] == action)


def _plan(**args: Any) -> list[dict[str, Any]]:
    return [{"id": "c", "type": "function",
             "function": {"name": "plan_support", "arguments": json.dumps(args)}}]


def _make_agent(bridge: FakeBridge, state: InMemoryBoardState) -> SpawnerAgent:
    agent = SpawnerAgent(session="test", state=state, bridge=bridge)
    agent._enabled = True
    agent._config = {"base_url": "http://fake/v1", "api_key": "k", "model": "m"}
    return agent


def _script(agent: SpawnerAgent, plan: list[dict[str, Any]]) -> None:
    async def fake_call(model, messages, tools, *, forced_tool):
        return plan
    agent._call_llm = fake_call  # type: ignore[assignment]


async def test_decides_nothing_emits_nothing():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    agent = _make_agent(bridge, state)
    _script(agent, _plan(want_image=False, reason="abstract"))

    await agent._spawn(SealEvent("leaf-1", "Recursion", "leaf", "it calls itself", "sibling"))

    assert bridge.actions() == []
    assert agent._spawned == {}


async def test_image_only_anchored_right():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    agent = _make_agent(bridge, state)
    _script(agent, _plan(want_image=True, image_prompt="a labelled mitochondrion",
                         image_caption="mitochondrion"))

    await agent._spawn(SealEvent("leaf-1", "Mitochondria", "leaf",
                                 "mitochondria make ATP", "sibling"))

    assert "requestImage" in bridge.actions()
    assert bridge.ids_for("requestImage") == ["leaf-1__img"]
    assert agent._spawned == {"leaf-1": ["leaf-1__img"]}


async def test_image_and_term_sticky():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    agent = _make_agent(bridge, state)
    _script(agent, _plan(want_image=True, image_prompt="a labelled mitochondrion",
                         key_term="ATP", term_gloss="the cell's energy currency"))

    await agent._spawn(SealEvent("leaf-1", "Mitochondria", "leaf",
                                 "mitochondria make ATP, the energy currency", "sibling"))

    assert "requestImage" in bridge.actions()
    assert "addNote" in bridge.actions()
    assert bridge.payload_for("addNote")["text"] == "ATP — the cell's energy currency"
    assert agent._spawned == {"leaf-1": ["leaf-1__img", "leaf-1__term"]}


async def test_term_without_gloss_is_dropped():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    agent = _make_agent(bridge, state)
    # key_term present but no gloss → faithful rule: no new content, skip it.
    _script(agent, _plan(want_image=False, key_term="ATP"))

    await agent._spawn(SealEvent("leaf-1", "T", "leaf", "raw", "sibling"))

    assert bridge.actions() == []


async def test_parent_seal_clears_descendant_margins_then_re_enriches():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    agent = _make_agent(bridge, state)
    _script(agent, _plan(want_image=True, image_prompt="diagram"))

    # Two leaf seals create margin images for the children.
    await agent._spawn(SealEvent("child-1", "C1", "leaf", "concrete thing one", "sibling"))
    await agent._spawn(SealEvent("child-2", "C2", "leaf", "concrete thing two", "sibling"))
    assert set(agent._spawned) == {"child-1", "child-2"}
    pre_removes = bridge.ids_for("removeNode")
    assert pre_removes == []

    # Parent seal: clears the children's margin images, then re-enriches the parent.
    await agent._spawn(
        SealEvent("parent-1", "Parent", "parent", "whole subtree raw", "ascend",
                  descendant_ids=["child-1", "child-2"])
    )

    removed = bridge.ids_for("removeNode")
    assert "child-1__img" in removed and "child-2__img" in removed
    assert "child-1" not in agent._spawned and "child-2" not in agent._spawned
    # Consolidated parent got its own margin image.
    assert agent._spawned == {"parent-1": ["parent-1__img"]}
    assert "parent-1__img" in bridge.ids_for("requestImage")


async def test_on_seal_enqueues_and_worker_drains():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    agent = _make_agent(bridge, state)
    _script(agent, _plan(want_image=True, image_prompt="a labelled gear train"))

    await agent.on_seal(SealEvent("leaf-9", "Gears", "leaf", "gears mesh and turn", "sibling"))
    await agent._queue.join()  # let the background worker finish

    assert "requestImage" in bridge.actions()
    assert agent._spawned == {"leaf-9": ["leaf-9__img"]}


async def test_disabled_agent_is_silent():
    bridge, state = FakeBridge(), InMemoryBoardState(session="test")
    agent = SpawnerAgent(session="test", state=state, bridge=bridge)
    agent._enabled = False  # no key
    await agent.on_seal(SealEvent("leaf-1", "T", "leaf", "raw", "sibling"))
    assert bridge.actions() == []

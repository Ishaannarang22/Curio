"""Tests for agent/topic_boundary.py — the FrameProcessor wiring.

Offline: a scripted fake classifier (no LLM), a FakeBridge (records sends), and a
recording seal handler. Verifies the seam fires on seal, raw is mirrored to the board,
and the trailing topic seals on close.
"""

from __future__ import annotations

from typing import Any

import pytest

from topic_boundary import TopicBoundaryProcessor
from topic_tree import Move, SealEvent, Verdict

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

    def markdown_for(self, block_id: str) -> list[str]:
        return [
            s["payload"]["markdown"]
            for s in self.sent
            if s["action"] == "addMarkdown" and s["payload"].get("id") == block_id
        ]


class ScriptedClassifier:
    """Returns a queued Verdict per call, ignoring inputs."""

    enabled = True

    def __init__(self, verdicts: list[Verdict]) -> None:
        self._verdicts = list(verdicts)
        self.calls = 0

    async def classify(self, *, skeleton: str, active_raw: str, utterance: str) -> Verdict:
        self.calls += 1
        return self._verdicts.pop(0) if self._verdicts else Verdict(Move.CONTINUE)

    async def aclose(self) -> None:
        pass


def _make(bridge: FakeBridge, verdicts: list[Verdict]):
    seals: list[SealEvent] = []

    async def on_seal(event: SealEvent) -> None:
        seals.append(event)

    proc = TopicBoundaryProcessor(
        session="test",
        classifier=ScriptedClassifier(verdicts),
        bridge=bridge,
        on_seal=on_seal,
    )
    return proc, seals


async def test_seal_seam_fires_and_raw_is_mirrored():
    bridge = FakeBridge()
    proc, seals = _make(
        bridge,
        [
            Verdict(Move.DESCEND, label="Photosynthesis"),  # bootstrap-ish first topic
            Verdict(Move.SIBLING, label="Respiration"),     # seals topic 1
        ],
    )

    await proc._on_utterance("Photosynthesis converts light to sugar.")
    await proc._on_utterance("Respiration releases that energy.")

    # The SIBLING sealed exactly one leaf, handed to the seam with its own raw.
    assert len(seals) == 1
    assert seals[0].kind == "leaf"
    assert seals[0].raw == "Photosynthesis converts light to sugar."

    # Each turn mirrored the active node's raw to the board, and cleared the live block.
    assert "addMarkdown" in bridge.actions()
    assert "removeNode" in bridge.actions()
    # The sealed node's block still carries its verbatim raw (Structuring Agent will
    # later collapse it).
    sealed_block = seals[0].node_id
    assert any("Photosynthesis converts light to sugar." in md for md in bridge.markdown_for(sealed_block))


async def test_close_seals_trailing_topic():
    bridge = FakeBridge()
    proc, seals = _make(bridge, [Verdict(Move.DESCEND, label="Only Topic")])

    await proc._on_utterance("This is the only thing I talked about.")
    assert seals == []  # nothing sealed yet

    await proc.close()

    # Session end seals the trailing topic via the seam.
    assert len(seals) == 1
    assert seals[0].reason == "session_end"
    assert seals[0].raw == "This is the only thing I talked about."


async def test_disabled_classifier_degrades_to_flat_topic():
    bridge = FakeBridge()

    class Disabled:
        # Mirrors the real TopicClassifier contract: when disabled, classify still
        # works and just returns CONTINUE every turn (no network).
        enabled = False

        async def classify(self, **kw) -> Verdict:
            return Verdict(Move.CONTINUE)

        async def aclose(self):
            pass

    seals: list[SealEvent] = []

    async def on_seal(e: SealEvent) -> None:
        seals.append(e)

    proc = TopicBoundaryProcessor(
        session="test", classifier=Disabled(), bridge=bridge, on_seal=on_seal
    )
    # Disabled classifier → CONTINUE every turn; with no topic yet the first turn
    # still bootstraps one flat topic, the rest append to it. No seals mid-session.
    await proc._on_utterance("first")
    await proc._on_utterance("second")
    assert seals == []
    await proc.close()
    assert len(seals) == 1  # trailing seal of the single flat topic
    assert seals[0].raw == "first\nsecond"

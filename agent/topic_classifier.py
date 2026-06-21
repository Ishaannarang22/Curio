"""topic_classifier.py — the cheap per-turn topic-boundary classifier.

One LLM call per finished utterance. Given the topic **tree skeleton** (ids + labels
+ state), the **full raw of the active node**, and the **new utterance**, it returns
a single tree-move ``Verdict`` (see ``topic_tree.Move``). This is the hot-path hook
that ultimately fires the Structuring Agent — so it runs a **fast/cheap, Haiku-class**
model, deliberately distinct from the heavier structuring model (implementation.md
§3.3, decision #19).

Design notes
============
- **One tool, forced.** The model must answer through the single ``emit_verdict``
  tool — no prose. This keeps parsing robust and the output strictly typed.
- **Fail safe.** Any error (no key, network, malformed args, unknown move) collapses
  to ``CONTINUE``: the utterance is appended to the active node and *nothing seals*.
  A missed boundary is recoverable (the next turn re-decides); a spurious seal would
  fire structuring on a half-finished topic.
- **Injectable.** ``_call_llm`` is a thin seam so tests monkeypatch it (or pass a
  whole fake classifier to ``TopicBoundaryProcessor``) and never touch the network.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

import httpx
import sentry_sdk
from loguru import logger

from topic_tree import Move, Verdict


# ---------------------------------------------------------------------------
# Model config — fast/cheap, OpenAI-compatible. Mirrors board_writer's resolver
# but defaults to a Haiku-class model (the classifier is the hot path).
# ---------------------------------------------------------------------------


def _resolve_classifier_config() -> Optional[dict[str, Any]]:
    """Resolve an OpenAI-compatible endpoint for the classifier.

    Order: Vercel AI Gateway (Claude Haiku) → Z.AI (GLM fast). Returns None when no
    key is configured → the classifier disables itself and the processor degrades to
    a single flat topic (live raw still mirrors). ``CLASSIFIER_MODEL`` overrides the
    model id on either path.
    """
    gateway_key = os.getenv("AI_GATEWAY_API_KEY")
    if gateway_key:
        return {
            "base_url": "https://ai-gateway.vercel.sh/v1",
            "api_key": gateway_key,
            "model": os.getenv("CLASSIFIER_MODEL", "anthropic/claude-haiku-4-5"),
        }
    zai_key = os.getenv("ZAI_API_KEY")
    if zai_key:
        return {
            "base_url": os.getenv("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4/"),
            "api_key": zai_key,
            "model": os.getenv("CLASSIFIER_MODEL") or os.getenv("ZAI_MODEL", "glm-5-turbo"),
            # GLM reasons by default and leaks chain-of-thought; the classifier only
            # needs one tool call, so disable thinking (latency + cost).
            "extra": {"thinking": {"type": "disabled"}},
        }
    return None


# ---------------------------------------------------------------------------
# Prompt + tool schema
# ---------------------------------------------------------------------------

_SYSTEM = """\
You are the topic-boundary classifier for Curio, a voice-first study app. A student
is explaining a subject out loud (the Feynman technique). Their speech is organized
into a RECURSIVE TREE OF TOPICS. Your ONLY job: read the latest finished utterance
and decide how it moves through that tree. You do not write notes or talk back.

You are given:
1. TREE SKELETON — every topic node as an indented outline: its id, its label, and
   its state (ACTIVE = the node the student is currently on; open = a parent still
   being built or an unsealed sibling; sealed = a finished topic, a valid RETURN
   target). Labels only — no contents.
2. ACTIVE NODE RAW — everything the student has said so far on the ACTIVE node.
3. NEW UTTERANCE — the sentence to place.

Choose exactly ONE move and answer with the emit_verdict tool:

- CONTINUE — the utterance is still about the ACTIVE node. (Default; prefer this when
  unsure. A missed boundary is cheap to fix next turn; a wrong split is not.)
- DESCEND — the student is drilling into a SUB-topic of the active node (a specific
  example, mechanism, or case of it). Provide a short `label` for the new child.
- SIBLING — the student has moved on to a NEW topic at the SAME level (a peer of the
  active node, under the same parent). Provide a short `label` for the new sibling.
- ASCEND — the student has zoomed back OUT to the parent topic, speaking about it in
  general again rather than a specific child.
- RETURN — the student is returning to a topic they already FINISHED. Provide its
  `target_id`, which MUST be one of the `sealed` node ids in the skeleton.

Rules:
- Boundaries are SEMANTIC only — judge meaning, never pauses or filler words.
- Respect a granularity floor: only DESCEND/SIBLING for a genuine topic, not every
  sentence. Keep related detail on the same node with CONTINUE.
- If the tree has no topics yet (only the root), DESCEND to open the first topic.
- Labels are 1–5 words, Title Case, no trailing punctuation.
Answer ONLY through the emit_verdict tool.
"""

_VERDICT_TOOL: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "emit_verdict",
            "description": "Emit the single tree-move for the new utterance.",
            "parameters": {
                "type": "object",
                "properties": {
                    "move": {
                        "type": "string",
                        "enum": ["CONTINUE", "DESCEND", "SIBLING", "ASCEND", "RETURN"],
                        "description": "How the utterance moves through the topic tree.",
                    },
                    "label": {
                        "type": "string",
                        "description": "Short topic label for the new node. REQUIRED for DESCEND and SIBLING.",
                    },
                    "target_id": {
                        "type": "string",
                        "description": "Id of the sealed node to re-open. REQUIRED for RETURN; must match a sealed id in the skeleton.",
                    },
                },
                "required": ["move"],
            },
        },
    }
]


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------


class TopicClassifier:
    """LLM classifier producing one ``Verdict`` per utterance. Errors → CONTINUE."""

    def __init__(self, *, http: httpx.AsyncClient | None = None) -> None:
        self._config = _resolve_classifier_config()
        self._http = http or httpx.AsyncClient(timeout=15)
        if self._config is not None:
            logger.info(f"TopicClassifier enabled: model={self._config['model']!r}")
        else:
            logger.warning(
                "TopicClassifier disabled (no AI_GATEWAY_API_KEY / ZAI_API_KEY). "
                "Topic boundaries fall back to a single flat topic; live raw still mirrors."
            )

    @property
    def enabled(self) -> bool:
        return self._config is not None

    async def classify(
        self,
        *,
        skeleton: str,
        active_raw: str,
        utterance: str,
    ) -> Verdict:
        """Return the tree-move for ``utterance``. Never raises — errors → CONTINUE."""
        if not self.enabled:
            return Verdict(Move.CONTINUE)

        user = (
            f"TREE SKELETON:\n{skeleton}\n\n"
            f"ACTIVE NODE RAW:\n{active_raw or '(empty — this node has no utterances yet)'}\n\n"
            f"NEW UTTERANCE:\n{utterance}"
        )
        messages = [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": user},
        ]
        tool_calls = await self._call_llm(messages, _VERDICT_TOOL)
        return _parse_verdict(tool_calls)

    async def _call_llm(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Thin, monkeypatchable wrapper. Returns tool_calls (empty list on error)."""
        assert self._config is not None
        try:
            body: dict[str, Any] = {
                "model": self._config["model"],
                "messages": messages,
                "tools": tools,
                # Force the one tool so the model can't answer in prose.
                "tool_choice": {"type": "function", "function": {"name": "emit_verdict"}},
                "temperature": 0.0,
                "max_tokens": 200,
            }
            body.update(self._config.get("extra") or {})
            resp = await self._http.post(
                f"{self._config['base_url'].rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {self._config['api_key']}"},
                json=body,
                timeout=15,
            )
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
            msg = data.get("choices", [{}])[0].get("message", {})
            return msg.get("tool_calls") or []
        except Exception as exc:
            logger.error(f"TopicClassifier._call_llm error: {exc}")
            sentry_sdk.capture_exception(exc)
            return []

    async def aclose(self) -> None:
        await self._http.aclose()


def _parse_verdict(tool_calls: list[dict[str, Any]]) -> Verdict:
    """Turn the first emit_verdict tool call into a Verdict. Anything off → CONTINUE."""
    if not tool_calls:
        return Verdict(Move.CONTINUE)
    raw_args = tool_calls[0].get("function", {}).get("arguments", {})
    try:
        args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
    except Exception:
        logger.warning("TopicClassifier: malformed verdict arguments — defaulting to CONTINUE")
        return Verdict(Move.CONTINUE)

    move_raw = str(args.get("move", "")).strip().upper()
    try:
        move = Move(move_raw)
    except ValueError:
        logger.warning(f"TopicClassifier: unknown move {move_raw!r} — defaulting to CONTINUE")
        return Verdict(Move.CONTINUE)

    label = args.get("label")
    target_id = args.get("target_id")

    # Guard required fields; a structurally-incomplete verdict degrades to CONTINUE
    # rather than minting a blank-labelled node or returning to nowhere.
    if move in (Move.DESCEND, Move.SIBLING) and not (isinstance(label, str) and label.strip()):
        logger.warning(f"TopicClassifier: {move.value} without a label — defaulting to CONTINUE")
        return Verdict(Move.CONTINUE)
    if move is Move.RETURN and not (isinstance(target_id, str) and target_id.strip()):
        logger.warning("TopicClassifier: RETURN without target_id — defaulting to CONTINUE")
        return Verdict(Move.CONTINUE)

    return Verdict(
        move,
        label=label.strip() if isinstance(label, str) else None,
        target_id=target_id.strip() if isinstance(target_id, str) else None,
    )

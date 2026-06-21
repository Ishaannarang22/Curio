"""topic_tree.py — the recursive topic tree + verdict application (PURE, no I/O).

This is the data model behind Curio's **topic boundary detection** (prd.md §1.2–1.3,
decisions #19–22). A student talks through a subject out loud; their utterances are
placed into an implicit, recursive tree of topics. A cheap per-turn classifier
(``topic_classifier.py``) decides, for each finished utterance, how the tree should
move; this module applies that move and reports which nodes just **sealed**.

Why a separate pure module
==========================
No LLM, no Redis, no HTTP, no pipecat. Every rule the locked spec defines is encoded
here as plain Python so it can be unit-tested exhaustively. ``topic_boundary.py`` owns
the I/O (classifier call, board mirror, seal seam); this owns the *semantics*.

The five moves (the verdict vocabulary)
=======================================
Each move is judged against the **active node** (the leaf the student is currently
on) — its full raw plus the tree skeleton.

- ``CONTINUE``       — same node; append the utterance to the active node's raw.
- ``DESCEND(label)`` — drill into a sub-topic. The active node stays **open** and
  becomes a parent; a new child (``label``) becomes active. No seal.
- ``SIBLING(label)`` — new topic at the same level. The current leaf **seals**; a new
  sibling under the same parent becomes active.
- ``ASCEND``         — the student zoomed back out to the parent topic. The current
  node **seals** (a leaf seal, or a *parent seal* if it already had children); the
  parent becomes active.
- ``RETURN(id)``     — re-open a previously sealed node and append to it. The node
  the student was on seals; the target node (and its ancestors) re-open.

Invariants (locked spec)
========================
- **Attribution → destination.** The utterance that triggers a boundary belongs to
  the node the student moved *to*, never the node they left. (Sealed nodes keep only
  their own raw.)
- **Sealing is semantic only.** No timers, no voice gaps. A node seals only when the
  student moves off it — except the **trailing** open path, which seals on session
  end (``seal_trailing``), the one non-content trigger.
- **Leaf seal vs parent seal.** A leaf seal carries the leaf's *own* raw. A parent
  seal (an internal node whose whole subtree is now sealed/left) carries the
  **whole subtree's** raw — the Structuring Agent re-renders it and decides 1-vs-N
  granularity, overriding the provisional per-leaf artifacts.
- **Raw is the source of truth.** Each node's ``raw`` is the permanent record;
  structure is a regenerable projection of it (decision #9, prd.md §1.4).

The seal events this module emits are the **trigger contract** the Structuring Agent
consumes (see ``SealEvent``).
"""

from __future__ import annotations

import itertools
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ---------------------------------------------------------------------------
# Verdict vocabulary (the classifier's output, this module's input)
# ---------------------------------------------------------------------------


class Move(str, Enum):
    """The five tree-moves a finished utterance can imply."""

    CONTINUE = "CONTINUE"
    DESCEND = "DESCEND"
    SIBLING = "SIBLING"
    ASCEND = "ASCEND"
    RETURN = "RETURN"


@dataclass(frozen=True)
class Verdict:
    """One classifier decision for one utterance.

    ``label`` is required for DESCEND / SIBLING (the new node's topic label).
    ``target_id`` is required for RETURN (an existing sealed node's id).
    """

    move: Move
    label: Optional[str] = None
    target_id: Optional[str] = None


@dataclass
class SealEvent:
    """A node just sealed — the Structuring Agent's trigger (handoff "what a seal fires").

    Attributes
    ----------
    node_id, label : identity of the sealed node.
    kind : ``"leaf"`` (structure this leaf's own raw, provisional/live) or
        ``"parent"`` (re-structure the whole subtree, overriding provisional views).
    raw : the exact text to structure — the leaf's own raw, or the whole subtree's
        raw for a parent seal. The Structuring Agent reads *only* this immutable raw.
    reason : what caused the seal — ``"sibling" | "ascend" | "return" | "session_end"``.
        Diagnostic only; the Structuring Agent keys off ``kind``.
    descendant_ids : for a ``parent`` seal, every descendant node id (their board
        blocks are the provisional child artifacts a MERGE must clear). Empty for a
        leaf seal.
    """

    node_id: str
    label: str
    kind: str  # "leaf" | "parent"
    raw: str
    reason: str
    descendant_ids: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Tree node
# ---------------------------------------------------------------------------


def _slugify(label: str) -> str:
    """Turn a topic label into a short, id-safe slug (matches board key charset)."""
    s = re.sub(r"[^\w\s-]", "", (label or "").lower()).strip()
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s[:60] or "topic"


class TopicNode:
    """One node in the topic tree. Its ``raw`` is the permanent source of truth."""

    __slots__ = ("id", "label", "raw", "children", "parent", "sealed", "structured")

    def __init__(self, node_id: str, label: str, parent: "Optional[TopicNode]" = None):
        self.id = node_id
        self.label = label
        self.raw: list[str] = []
        self.children: list[TopicNode] = []
        self.parent: Optional[TopicNode] = parent
        self.sealed = False
        # Set by the Structuring Agent once an artifact exists (consumed next session).
        self.structured = False

    @property
    def is_leaf(self) -> bool:
        return not self.children

    def own_raw(self) -> str:
        """This node's own utterances, joined — what a *leaf* seal structures."""
        return "\n".join(self.raw)

    def subtree_raw(self) -> str:
        """This node's raw followed by every descendant's, depth-first in order —
        what a *parent* seal structures."""
        parts: list[str] = []
        own = self.own_raw()
        if own:
            parts.append(own)
        for child in self.children:
            sub = child.subtree_raw()
            if sub:
                parts.append(sub)
        return "\n".join(parts)

    def descendant_ids(self) -> list[str]:
        """Every descendant node id, depth-first (excludes this node itself)."""
        out: list[str] = []
        for child in self.children:
            out.append(child.id)
            out.extend(child.descendant_ids())
        return out

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        flag = "sealed" if self.sealed else "open"
        return f"<TopicNode {self.id!r} {self.label!r} {flag} children={len(self.children)}>"


# ---------------------------------------------------------------------------
# The tree
# ---------------------------------------------------------------------------


class TopicTree:
    """A recursive topic tree with a single ``active`` pointer.

    The ``root`` is an implicit session container — never sealed, never structured;
    it just holds the top-level topics. Before the first utterance the active node
    *is* the root; the first turn bootstraps the first real topic (see ``apply``).
    """

    def __init__(self, root_label: str = "session"):
        self.root = TopicNode("root", root_label, parent=None)
        self.active: TopicNode = self.root
        self._counter = itertools.count(1)

    # -- introspection -------------------------------------------------------

    def nodes(self) -> list[TopicNode]:
        """Every node including the root, depth-first."""
        out: list[TopicNode] = []
        stack = [self.root]
        while stack:
            node = stack.pop()
            out.append(node)
            # push children reversed so iteration is left-to-right
            stack.extend(reversed(node.children))
        return out

    def get(self, node_id: str) -> Optional[TopicNode]:
        for node in self.nodes():
            if node.id == node_id:
                return node
        return None

    def active_raw(self) -> str:
        """Full raw of the active node — a classifier input each turn."""
        return self.active.own_raw()

    def sealed_ids(self) -> list[str]:
        """Ids of every sealed node — the valid RETURN targets."""
        return [n.id for n in self.nodes() if n.sealed and n is not self.root]

    # -- skeleton (classifier prompt input) ----------------------------------

    def render_skeleton(self) -> str:
        """Compact indented outline: ids, labels, and per-node state.

        Labels only — never raw text (the active node's raw is sent separately).
        States: ``ACTIVE`` (current node), ``open`` (an ancestor still being built,
        or an unsealed sibling), ``sealed`` (a candidate RETURN target).
        """
        lines: list[str] = []
        self._render_node(self.root, 0, lines)
        return "\n".join(lines)

    def _render_node(self, node: TopicNode, depth: int, lines: list[str]) -> None:
        indent = "  " * depth
        if node is self.root:
            state = "root"
        elif node is self.active:
            state = "ACTIVE"
        elif node.sealed:
            state = "sealed"
        else:
            state = "open"
        lines.append(f'{indent}- [{node.id}] "{node.label}" ({state})')
        for child in node.children:
            self._render_node(child, depth + 1, lines)

    # -- the core: apply one verdict ----------------------------------------

    def apply(self, verdict: Verdict, utterance: str) -> list[SealEvent]:
        """Apply ``verdict`` for ``utterance``; return the seals it produced (in order).

        Bootstrap: while the active node is still the root there is no topic yet, so
        any verdict is coerced to ``DESCEND`` — the first utterance always opens the
        first topic. (The classifier is told to emit DESCEND on turn one anyway.)
        """
        utterance = utterance.strip()
        move = verdict.move

        if self.active is self.root and move is not Move.DESCEND:
            move = Move.DESCEND
            verdict = Verdict(Move.DESCEND, label=verdict.label)

        if move is Move.CONTINUE:
            self.active.raw.append(utterance)
            return []

        if move is Move.DESCEND:
            child = self._new_node(verdict.label or utterance, parent=self.active)
            self.active.children.append(child)
            child.raw.append(utterance)  # attribution → destination
            self.active = child
            return []

        if move is Move.SIBLING:
            old = self.active
            parent = old.parent or self.root
            sib = self._new_node(verdict.label or utterance, parent=parent)
            parent.children.append(sib)
            sib.raw.append(utterance)  # attribution → destination (new sibling)
            self.active = sib
            return self._seal(old, reason="sibling")

        if move is Move.ASCEND:
            old = self.active
            parent = old.parent or self.root
            self.active = parent
            parent.raw.append(utterance)  # attribution → destination (the parent)
            return self._seal(old, reason="ascend")

        if move is Move.RETURN:
            return self._apply_return(verdict, utterance)

        # Unknown move — safest is to treat it as CONTINUE (no seal, no data loss).
        self.active.raw.append(utterance)
        return []

    def _apply_return(self, verdict: Verdict, utterance: str) -> list[SealEvent]:
        target = self.get(verdict.target_id) if verdict.target_id else None
        if target is None or target is self.root:
            # Bad / missing target — fall back to CONTINUE rather than corrupt the tree.
            self.active.raw.append(utterance)
            return []

        old = self.active

        # Re-open the target and every ancestor, and move there FIRST — the active
        # path is always open, and _seal() must see ``old`` as off the active path.
        node: Optional[TopicNode] = target
        while node is not None:
            node.sealed = False
            node = node.parent
        target.raw.append(utterance)  # attribution → destination (the returned node)
        self.active = target

        # Now seal the node we left (unless it's the target itself or an ancestor of it).
        if old is not target and old is not self.root and not self._is_ancestor(old, target):
            return self._seal(old, reason="return")
        return []

    def seal_trailing(self) -> list[SealEvent]:
        """Session end: seal the still-open active path bottom-up (the trailing topic
        and any open ancestors). The one non-content seal trigger."""
        events: list[SealEvent] = []
        node = self.active
        while node is not None and node is not self.root:
            if not node.sealed:
                events.append(self._make_seal(node, reason="session_end"))
                node.sealed = True
            node = node.parent
        self.active = self.root
        return events

    # -- sealing -------------------------------------------------------------

    def _seal(self, node: TopicNode, reason: str) -> list[SealEvent]:
        """Seal ``node`` and cascade upward: an ancestor seals too once its whole
        subtree is sealed AND it is no longer on the active path (a *parent seal*)."""
        events: list[SealEvent] = []
        cur: Optional[TopicNode] = node
        while cur is not None and cur is not self.root and not cur.sealed:
            if self._on_active_path(cur):
                break
            if cur.is_leaf or all(c.sealed for c in cur.children):
                events.append(self._make_seal(cur, reason))
                cur.sealed = True
                cur = cur.parent
            else:
                break
        return events

    def _make_seal(self, node: TopicNode, reason: str) -> SealEvent:
        if node.is_leaf:
            return SealEvent(node.id, node.label, "leaf", node.own_raw(), reason)
        return SealEvent(
            node.id, node.label, "parent", node.subtree_raw(), reason,
            descendant_ids=node.descendant_ids(),
        )

    # -- helpers -------------------------------------------------------------

    def _new_node(self, label: str, parent: TopicNode) -> TopicNode:
        n = next(self._counter)
        return TopicNode(f"{_slugify(label)}-{n}", (label or "").strip() or "Topic", parent=parent)

    def _on_active_path(self, node: TopicNode) -> bool:
        """True if ``node`` is the active node or an ancestor of it."""
        cur: Optional[TopicNode] = self.active
        while cur is not None:
            if cur is node:
                return True
            cur = cur.parent
        return False

    @staticmethod
    def _is_ancestor(maybe_ancestor: TopicNode, node: TopicNode) -> bool:
        cur: Optional[TopicNode] = node.parent
        while cur is not None:
            if cur is maybe_ancestor:
                return True
            cur = cur.parent
        return False

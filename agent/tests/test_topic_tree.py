"""Tests for agent/topic_tree.py — the pure topic-tree semantics (no I/O).

Covers every move (CONTINUE / DESCEND / SIBLING / ASCEND / RETURN), the locked
invariants (destination attribution, semantic-only sealing, leaf-vs-parent seal raw),
and session-end trailing seal. No LLM, no network.
"""

from __future__ import annotations

from topic_tree import Move, SealEvent, TopicTree, Verdict


def _apply(tree: TopicTree, move: Move, utterance: str, **kw) -> list[SealEvent]:
    return tree.apply(Verdict(move, **kw), utterance)


# ---------------------------------------------------------------------------
# Bootstrap + CONTINUE + DESCEND
# ---------------------------------------------------------------------------


def test_first_turn_bootstraps_first_topic_even_without_descend():
    tree = TopicTree()
    # Classifier said CONTINUE, but there is no topic yet → coerced to DESCEND.
    events = _apply(tree, Move.CONTINUE, "Let's talk about photosynthesis.")
    assert events == []
    assert tree.active is not tree.root
    assert tree.active.parent is tree.root
    assert tree.active.own_raw() == "Let's talk about photosynthesis."


def test_continue_appends_to_active_no_seal():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Photosynthesis basics.", label="Photosynthesis")
    events = _apply(tree, Move.CONTINUE, "It happens in the chloroplast.")
    assert events == []
    assert tree.active.own_raw() == "Photosynthesis basics.\nIt happens in the chloroplast."


def test_descend_keeps_parent_open_and_attributes_to_child():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Sorting algorithms overview.", label="Sorting Algorithms")
    parent = tree.active
    events = _apply(tree, Move.DESCEND, "Bubble sort swaps neighbors.", label="Bubble Sort")
    assert events == []  # descending never seals
    assert not parent.sealed
    assert tree.active.parent is parent
    # Triggering utterance belongs to the destination (child), not the parent.
    assert tree.active.own_raw() == "Bubble sort swaps neighbors."
    assert parent.own_raw() == "Sorting algorithms overview."


# ---------------------------------------------------------------------------
# SIBLING — seals the leaf, attributes utterance to the new sibling
# ---------------------------------------------------------------------------


def test_sibling_seals_current_leaf_and_opens_new_sibling():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Sorting.", label="Sorting")
    _apply(tree, Move.DESCEND, "Bubble sort detail.", label="Bubble Sort")
    bubble = tree.active

    events = _apply(tree, Move.SIBLING, "Merge sort splits the list.", label="Merge Sort")

    assert len(events) == 1
    seal = events[0]
    assert seal.node_id == bubble.id
    assert seal.kind == "leaf"
    assert seal.raw == "Bubble sort detail."  # own raw only
    assert seal.reason == "sibling"
    assert bubble.sealed
    # New sibling is active, under the same parent, holds the trigger utterance.
    assert tree.active is not bubble
    assert tree.active.parent is bubble.parent
    assert tree.active.own_raw() == "Merge sort splits the list."


# ---------------------------------------------------------------------------
# ASCEND — seals the node left behind, lands on the parent
# ---------------------------------------------------------------------------


def test_ascend_seals_leaf_and_lands_on_parent():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Sorting in general.", label="Sorting")
    parent = tree.active
    _apply(tree, Move.DESCEND, "Bubble sort.", label="Bubble Sort")
    bubble = tree.active

    events = _apply(tree, Move.ASCEND, "Anyway, sorting is about ordering data.")

    assert [e.node_id for e in events] == [bubble.id]
    assert events[0].kind == "leaf"
    assert bubble.sealed
    assert tree.active is parent
    assert not parent.sealed  # parent is active now → stays open
    # Utterance attributed to the destination (the parent).
    assert parent.own_raw() == "Sorting in general.\nAnyway, sorting is about ordering data."


def test_second_ascend_off_a_parent_fires_a_parent_seal_with_subtree_raw():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Algorithms.", label="Algorithms")
    algorithms = tree.active
    _apply(tree, Move.DESCEND, "Sorting overview.", label="Sorting")
    sorting = tree.active
    _apply(tree, Move.DESCEND, "Bubble sort.", label="Bubble Sort")
    bubble = tree.active

    # Ascend once: seal the leaf, land on Sorting (now active).
    _apply(tree, Move.ASCEND, "So that covers the simple sorts.")
    assert tree.active is sorting
    assert bubble.sealed

    # Ascend again off Sorting (a parent whose subtree is now fully sealed/left):
    # that is a PARENT seal carrying the whole subtree's raw.
    events = _apply(tree, Move.ASCEND, "Stepping back to algorithms generally.")
    assert tree.active is algorithms
    assert sorting.sealed
    parent_seals = [e for e in events if e.kind == "parent"]
    assert [e.node_id for e in parent_seals] == [sorting.id]
    # Subtree raw includes the parent's own raw + the sealed child's raw.
    assert "Sorting overview." in parent_seals[0].raw
    assert "Bubble sort." in parent_seals[0].raw
    assert "So that covers the simple sorts." in parent_seals[0].raw


# ---------------------------------------------------------------------------
# RETURN — re-opens a sealed node, seals the one we left
# ---------------------------------------------------------------------------


def test_return_reopens_sealed_node_and_appends():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Photosynthesis.", label="Photosynthesis")
    photo = tree.active
    _apply(tree, Move.SIBLING, "Cellular respiration.", label="Cellular Respiration")
    respiration = tree.active
    assert photo.sealed

    events = _apply(tree, Move.RETURN, "Oh, photosynthesis also needs water.", target_id=photo.id)

    # Returning seals the node we left (respiration) and re-opens the target.
    assert respiration.sealed
    assert [e.node_id for e in events] == [respiration.id]
    assert not photo.sealed
    assert tree.active is photo
    assert photo.own_raw() == "Photosynthesis.\nOh, photosynthesis also needs water."


def test_return_to_missing_id_falls_back_to_continue():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Topic A.", label="A")
    a = tree.active
    events = _apply(tree, Move.RETURN, "still talking about A", target_id="does-not-exist")
    assert events == []
    assert tree.active is a
    assert a.own_raw() == "Topic A.\nstill talking about A"


# ---------------------------------------------------------------------------
# Session end — trailing seal
# ---------------------------------------------------------------------------


def test_seal_trailing_seals_open_active_path_bottom_up():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Algorithms.", label="Algorithms")
    algorithms = tree.active
    _apply(tree, Move.DESCEND, "Bubble sort.", label="Bubble Sort")
    bubble = tree.active

    events = tree.seal_trailing()

    # Both the trailing leaf and its open ancestor seal, leaf first.
    assert [e.node_id for e in events] == [bubble.id, algorithms.id]
    assert events[0].kind == "leaf"
    assert events[1].kind == "parent"
    assert all(e.reason == "session_end" for e in events)
    assert bubble.sealed and algorithms.sealed
    assert tree.active is tree.root


def test_seal_trailing_is_idempotent_on_already_sealed_nodes():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Only topic.", label="Only")
    _apply(tree, Move.SIBLING, "Second topic.", label="Second")
    # First topic already sealed by the SIBLING; only the trailing one remains open.
    events = tree.seal_trailing()
    assert len(events) == 1
    assert events[0].label == "Second"


# ---------------------------------------------------------------------------
# Skeleton rendering
# ---------------------------------------------------------------------------


def test_skeleton_marks_active_sealed_and_open_states():
    tree = TopicTree()
    _apply(tree, Move.DESCEND, "Sorting.", label="Sorting")
    _apply(tree, Move.DESCEND, "Bubble.", label="Bubble")
    _apply(tree, Move.SIBLING, "Merge.", label="Merge")
    skel = tree.render_skeleton()
    assert "(ACTIVE)" in skel
    assert "(sealed)" in skel  # Bubble was sealed by the SIBLING
    assert '"Sorting"' in skel and '"Merge"' in skel
    # The active node id is a valid RETURN-free state; sealed ids are returnable.
    assert tree.sealed_ids()  # at least Bubble

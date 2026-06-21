"""Tests for agent/board_state.py.

Uses fakeredis.aioredis so no real Redis instance is required.  Each test gets
a fresh FakeRedis client injected via the ``client`` kwarg on BoardState so the
store is fully isolated.

pytest-asyncio is configured per-module via ``pytestmark`` so we avoid touching
pyproject.toml or any shared config file.
"""

import json
import time

import pytest
import pytest_asyncio
import fakeredis.aioredis as fake_aioredis

from board_state import BoardState, _block_key, _index_key, _topic_key, _active_topic_key

# ---------------------------------------------------------------------------
# pytest-asyncio: use asyncio mode for this module only (avoids pyproject.toml edits)
# ---------------------------------------------------------------------------
pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def fake_client():
    """Yield a fresh FakeRedis client (decode_responses=True) and close it after."""
    client = fake_aioredis.FakeRedis(decode_responses=True)
    yield client
    await client.aclose()


@pytest_asyncio.fixture
async def state(fake_client):
    """Yield a BoardState wired to a fresh fakeredis instance."""
    bs = BoardState(session="test-session", client=fake_client)
    # connect() is a no-op when a client is injected, but call it to cover the path.
    await bs.connect()
    yield bs
    await bs.aclose()


def _make_block(
    block_id: str,
    topic_id: str = "topic-1",
    *,
    type_: str = "notes",
    title: str = "Test Block",
    content: str = "Line 1\nLine 2\nLine 3",
    bbox: dict | None = None,
    shape_ids: list | None = None,
) -> dict:
    return {
        "id": block_id,
        "topicId": topic_id,
        "type": type_,
        "title": title,
        "content": content,
        "bbox": bbox or {"x": 10, "y": 20, "w": 100, "h": 50},
        "shapeIds": shape_ids or [],
        "updatedAt": time.time(),
    }


# ---------------------------------------------------------------------------
# 1. Upsert → get round-trip
# ---------------------------------------------------------------------------

async def test_upsert_and_get_round_trip(state):
    """A block written with upsert_block must be fully retrievable via get_block."""
    rec = _make_block("b1", content="Hello world\nSecond line")
    await state.upsert_block(rec)

    fetched = await state.get_block("b1")
    assert fetched is not None
    assert fetched["id"] == "b1"
    assert fetched["topicId"] == "topic-1"
    assert fetched["type"] == "notes"
    assert fetched["title"] == "Test Block"
    assert fetched["content"] == "Hello world\nSecond line"
    assert fetched["bbox"] == {"x": 10, "y": 20, "w": 100, "h": 50}
    assert fetched["shapeIds"] == []


async def test_upsert_overwrites_existing(state):
    """A second upsert with the same id replaces the stored record."""
    await state.upsert_block(_make_block("b1", content="original"))
    await state.upsert_block(_make_block("b1", content="updated", title="New Title"))

    fetched = await state.get_block("b1")
    assert fetched["content"] == "updated"
    assert fetched["title"] == "New Title"


async def test_upsert_adds_to_index(state, fake_client):
    """upsert_block must add the block id to the session index set."""
    await state.upsert_block(_make_block("b1"))
    await state.upsert_block(_make_block("b2", topic_id="topic-2"))

    members = await fake_client.smembers(_index_key("test-session"))
    assert "b1" in members
    assert "b2" in members


async def test_upsert_adds_to_topic_set(state, fake_client):
    """upsert_block must add the block id to its topic's set."""
    await state.upsert_block(_make_block("b1", topic_id="t1"))
    await state.upsert_block(_make_block("b2", topic_id="t1"))
    await state.upsert_block(_make_block("b3", topic_id="t2"))

    t1_members = await fake_client.smembers(_topic_key("test-session", "t1"))
    t2_members = await fake_client.smembers(_topic_key("test-session", "t2"))
    assert t1_members == {"b1", "b2"}
    assert t2_members == {"b3"}


async def test_upsert_default_shape_ids(state):
    """shapeIds defaults to [] when not supplied."""
    rec = {
        "id": "b-no-shapes",
        "topicId": "t1",
        "type": "notes",
        "title": "",
        "content": "",
    }
    await state.upsert_block(rec)
    fetched = await state.get_block("b-no-shapes")
    assert fetched["shapeIds"] == []


# ---------------------------------------------------------------------------
# 2. remove_block — gone from block key, index, and topic set
# ---------------------------------------------------------------------------

async def test_remove_block_clears_record(state, fake_client):
    """After remove_block, get_block must return None."""
    await state.upsert_block(_make_block("b1", topic_id="t1"))
    await state.remove_block("b1")

    result = await state.get_block("b1")
    assert result is None


async def test_remove_block_clears_index(state, fake_client):
    """After remove_block, the id must not appear in the session index."""
    await state.upsert_block(_make_block("b1", topic_id="t1"))
    await state.upsert_block(_make_block("b2", topic_id="t1"))
    await state.remove_block("b1")

    members = await fake_client.smembers(_index_key("test-session"))
    assert "b1" not in members
    assert "b2" in members  # sibling untouched


async def test_remove_block_clears_topic_set(state, fake_client):
    """After remove_block, the id must not appear in its topic set."""
    await state.upsert_block(_make_block("b1", topic_id="t1"))
    await state.upsert_block(_make_block("b2", topic_id="t1"))
    await state.remove_block("b1")

    t1_members = await fake_client.smembers(_topic_key("test-session", "t1"))
    assert "b1" not in t1_members
    assert "b2" in t1_members


async def test_remove_nonexistent_is_silent(state):
    """Removing a block that does not exist must not raise."""
    await state.remove_block("does-not-exist")  # should not raise


# ---------------------------------------------------------------------------
# 3. Topic grouping via get_topic_blocks
# ---------------------------------------------------------------------------

async def test_get_topic_blocks_returns_correct_members(state):
    """get_topic_blocks must return exactly the blocks tagged with that topic."""
    await state.upsert_block(_make_block("b1", topic_id="t1", content="alpha"))
    await state.upsert_block(_make_block("b2", topic_id="t1", content="beta"))
    await state.upsert_block(_make_block("b3", topic_id="t2", content="gamma"))

    t1_blocks = await state.get_topic_blocks("t1")
    ids = {b["id"] for b in t1_blocks}
    assert ids == {"b1", "b2"}

    t2_blocks = await state.get_topic_blocks("t2")
    assert len(t2_blocks) == 1
    assert t2_blocks[0]["id"] == "b3"


async def test_get_topic_blocks_empty_topic(state):
    """get_topic_blocks for an unknown topic must return an empty list."""
    result = await state.get_topic_blocks("nonexistent-topic")
    assert result == []


# ---------------------------------------------------------------------------
# 4. get_state_summary shape
# ---------------------------------------------------------------------------

async def test_get_state_summary_returns_compact_fields(state):
    """Summary dicts must contain exactly {id, topicId, type, title, summary, bbox}."""
    await state.upsert_block(_make_block("b1", topic_id="t1", content="First line\nSecond line"))
    await state.upsert_block(_make_block("b2", topic_id="t2", content="Another block"))

    summaries = await state.get_state_summary()
    assert len(summaries) == 2

    required_keys = {"id", "topicId", "type", "title", "summary", "bbox"}
    for s in summaries:
        assert set(s.keys()) == required_keys, f"unexpected keys: {set(s.keys())}"


async def test_get_state_summary_snippet(state):
    """summary field must be the first line of content, capped at 120 chars."""
    long_content = "A" * 200 + "\nSecond line"
    await state.upsert_block(_make_block("b1", content=long_content))

    summaries = await state.get_state_summary()
    assert len(summaries) == 1
    assert summaries[0]["summary"] == "A" * 120


async def test_get_state_summary_multiline_takes_first(state):
    """summary uses the first non-blank line when content has multiple lines."""
    await state.upsert_block(_make_block("b1", content="\n\nActual first line\nSecond"))

    summaries = await state.get_state_summary()
    assert summaries[0]["summary"] == "Actual first line"


async def test_get_state_summary_empty_board(state):
    """get_state_summary on an empty session must return []."""
    result = await state.get_state_summary()
    assert result == []


async def test_get_state_summary_does_not_include_content(state):
    """Summary compact dict must NOT include the full 'content' field."""
    await state.upsert_block(_make_block("b1", content="full content here"))
    summaries = await state.get_state_summary()
    assert "content" not in summaries[0]


# ---------------------------------------------------------------------------
# 5. update_geometry
# ---------------------------------------------------------------------------

async def test_update_geometry_merges_bbox(state):
    """update_geometry must overwrite the bbox and bump updatedAt."""
    await state.upsert_block(_make_block("b1", bbox={"x": 0, "y": 0, "w": 10, "h": 10}))

    new_bbox = {"x": 50, "y": 60, "w": 200, "h": 100}
    await state.update_geometry("b1", new_bbox)

    fetched = await state.get_block("b1")
    assert fetched["bbox"] == new_bbox
    # Other fields preserved.
    assert fetched["id"] == "b1"
    assert fetched["topicId"] == "topic-1"


async def test_update_geometry_nonexistent_is_silent(state):
    """update_geometry on a missing block must not raise."""
    await state.update_geometry("ghost-block", {"x": 1, "y": 2, "w": 3, "h": 4})


# ---------------------------------------------------------------------------
# 6. clear
# ---------------------------------------------------------------------------

async def test_clear_removes_all_session_keys(state, fake_client):
    """clear() must wipe blocks, index, topic sets, and active_topic."""
    await state.upsert_block(_make_block("b1", topic_id="t1"))
    await state.upsert_block(_make_block("b2", topic_id="t1"))
    await state.upsert_block(_make_block("b3", topic_id="t2"))
    await state.set_active_topic("t2")

    await state.clear()

    # Block keys gone.
    assert await state.get_block("b1") is None
    assert await state.get_block("b2") is None
    assert await state.get_block("b3") is None

    # Index gone.
    members = await fake_client.smembers(_index_key("test-session"))
    assert members == set()

    # Topic sets gone.
    t1 = await fake_client.smembers(_topic_key("test-session", "t1"))
    t2 = await fake_client.smembers(_topic_key("test-session", "t2"))
    assert t1 == set()
    assert t2 == set()

    # Active topic gone.
    assert await state.get_active_topic() is None


async def test_clear_on_empty_session_is_silent(state):
    """clear() on an empty session must not raise."""
    await state.clear()


# ---------------------------------------------------------------------------
# 7. Active topic
# ---------------------------------------------------------------------------

async def test_set_and_get_active_topic(state):
    """set_active_topic / get_active_topic must round-trip correctly."""
    assert await state.get_active_topic() is None

    await state.set_active_topic("my-topic")
    assert await state.get_active_topic() == "my-topic"

    await state.set_active_topic("new-topic")
    assert await state.get_active_topic() == "new-topic"


# ---------------------------------------------------------------------------
# 8. Graceful degradation — broken client must NEVER raise out of BoardState
# ---------------------------------------------------------------------------

class _AlwaysFailingRedis:
    """A fake client whose every method raises RuntimeError immediately."""

    async def ping(self):
        raise RuntimeError("Redis is down")

    async def set(self, *a, **kw):
        raise RuntimeError("Redis is down")

    async def get(self, *a, **kw):
        raise RuntimeError("Redis is down")

    async def delete(self, *a, **kw):
        raise RuntimeError("Redis is down")

    async def sadd(self, *a, **kw):
        raise RuntimeError("Redis is down")

    async def srem(self, *a, **kw):
        raise RuntimeError("Redis is down")

    async def smembers(self, *a, **kw):
        raise RuntimeError("Redis is down")

    def pipeline(self):
        return _AlwaysFailingPipeline()

    async def aclose(self):
        pass


class _AlwaysFailingPipeline:
    def set(self, *a, **kw):
        return self

    def get(self, *a, **kw):
        return self

    def delete(self, *a, **kw):
        return self

    def sadd(self, *a, **kw):
        return self

    def srem(self, *a, **kw):
        return self

    async def execute(self):
        raise RuntimeError("Pipeline is down")


@pytest_asyncio.fixture
async def broken_state():
    """BoardState backed by a client that always raises."""
    bs = BoardState(session="broken-session", client=_AlwaysFailingRedis())  # type: ignore[arg-type]
    yield bs
    await bs.aclose()


async def test_upsert_block_swallows_redis_error(broken_state):
    await broken_state.upsert_block(_make_block("x1"))  # must not raise


async def test_get_block_swallows_redis_error(broken_state):
    result = await broken_state.get_block("x1")
    assert result is None  # swallowed; returns None


async def test_remove_block_swallows_redis_error(broken_state):
    await broken_state.remove_block("x1")  # must not raise


async def test_get_topic_blocks_swallows_redis_error(broken_state):
    result = await broken_state.get_topic_blocks("t1")
    assert result == []


async def test_get_state_summary_swallows_redis_error(broken_state):
    result = await broken_state.get_state_summary()
    assert result == []


async def test_update_geometry_swallows_redis_error(broken_state):
    await broken_state.update_geometry("x1", {"x": 1, "y": 2, "w": 3, "h": 4})  # must not raise


async def test_clear_swallows_redis_error(broken_state):
    await broken_state.clear()  # must not raise


async def test_set_active_topic_swallows_redis_error(broken_state):
    await broken_state.set_active_topic("t1")  # must not raise


async def test_get_active_topic_swallows_redis_error(broken_state):
    result = await broken_state.get_active_topic()
    assert result is None


# ---------------------------------------------------------------------------
# 9. get_block returns None for missing id
# ---------------------------------------------------------------------------

async def test_get_block_missing_returns_none(state):
    result = await state.get_block("definitely-not-there")
    assert result is None

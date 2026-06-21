"""Redis-backed board state store for the Curio voice→whiteboard harness.

Maintains a session-scoped view of all logical blocks on the whiteboard,
grouped by topic. Every public method is async and swallows all Redis errors
so the voice pipeline survives a Redis outage without raising.

Key schema (shared with the Next.js board-side M4 module):
    board:{session}:block:{id}      — JSON-serialised BlockRecord
    board:{session}:index           — Redis set of all block ids in the session
    board:{session}:topic:{topicId} — Redis set of block ids belonging to a topic
    board:{session}:active_topic    — string (current active topic id)

BlockRecord fields:
    id, topicId, type, title, content, bbox:{x,y,w,h}, shapeIds:[...], updatedAt
"""

import json
import re
import time
from typing import Any

import sentry_sdk
from loguru import logger

import redis.asyncio as aioredis


def _redact_url(url: str) -> str:
    """Replace any password in a Redis URL with '***' before logging."""
    return re.sub(r"(:)[^:@/]+(@)", r"\1***\2", url)

# Default Redis URL; callers may override via constructor.
_DEFAULT_REDIS_URL = "redis://localhost:6379"


def _block_key(session: str, block_id: str) -> str:
    return f"board:{session}:block:{block_id}"


def _index_key(session: str) -> str:
    return f"board:{session}:index"


def _topic_key(session: str, topic_id: str) -> str:
    return f"board:{session}:topic:{topic_id}"


def _active_topic_key(session: str) -> str:
    return f"board:{session}:active_topic"


def _summary_snippet(content: str | None) -> str:
    """Return a short (~120-char) snippet of block content for state summaries."""
    if not content:
        return ""
    # Use the first non-blank line, then truncate to 120 chars.
    first_line = next((ln.strip() for ln in content.splitlines() if ln.strip()), "")
    return first_line[:120]


class BoardState:
    """Async Redis-backed board state for one whiteboard session.

    Lifecycle
    ---------
    Construct → ``await connect()`` → use → ``await aclose()``.
    Alternatively, pass a pre-built ``client`` keyword argument (used in tests
    via fakeredis) — ``connect()`` becomes a no-op in that case.
    """

    def __init__(
        self,
        redis_url: str = _DEFAULT_REDIS_URL,
        session: str = "default",
        *,
        client: aioredis.Redis | None = None,
    ) -> None:
        self._redis_url = redis_url
        self._session = session
        # If a client is injected (e.g. fakeredis in tests), use it directly and
        # skip auto-connection.  Otherwise connect() must be called before use.
        self._client: aioredis.Redis | None = client
        self._owns_client = client is None  # only close what we created

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Open the Redis connection.  No-op if a client was injected."""
        if self._client is not None:
            return
        try:
            self._client = aioredis.from_url(
                self._redis_url,
                decode_responses=True,
                socket_connect_timeout=5,
            )
            # Ping to surface connection errors early.
            await self._client.ping()
            # Log the URL with any embedded password redacted.
            logger.info(f"BoardState connected: session={self._session!r} url={_redact_url(self._redis_url)}")
        except Exception as exc:
            logger.error(f"BoardState.connect failed (Redis may be down): {exc}")
            sentry_sdk.capture_exception(exc)
            self._client = None  # operate in degraded mode

    async def aclose(self) -> None:
        """Close the Redis connection if we own it."""
        if self._client is not None and self._owns_client:
            try:
                await self._client.aclose()
            except Exception as exc:
                logger.debug(f"BoardState.aclose: {exc}")
            finally:
                self._client = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _client_or_none(self) -> aioredis.Redis | None:
        """Return the Redis client, or None if unavailable (degraded mode)."""
        return self._client

    # ------------------------------------------------------------------
    # Active topic
    # ------------------------------------------------------------------

    async def set_active_topic(self, topic_id: str) -> None:
        """Persist the active topic id for this session."""
        client = self._client_or_none()
        if client is None:
            return
        try:
            await client.set(_active_topic_key(self._session), topic_id)
        except Exception as exc:
            logger.error(f"BoardState.set_active_topic failed: {exc}")
            sentry_sdk.capture_exception(exc)

    async def get_active_topic(self) -> str | None:
        """Return the current active topic id, or None if not set / Redis down."""
        client = self._client_or_none()
        if client is None:
            return None
        try:
            return await client.get(_active_topic_key(self._session))
        except Exception as exc:
            logger.error(f"BoardState.get_active_topic failed: {exc}")
            sentry_sdk.capture_exception(exc)
            return None

    # ------------------------------------------------------------------
    # Block CRUD
    # ------------------------------------------------------------------

    async def upsert_block(self, rec: dict[str, Any]) -> None:
        """Create or fully replace a block record.

        ``rec`` must contain at minimum ``id`` and ``topicId``.  Missing optional
        fields are defaulted: ``bbox`` → ``{x:0,y:0,w:0,h:0}``, ``shapeIds`` → ``[]``,
        ``updatedAt`` → current epoch seconds.
        """
        client = self._client_or_none()
        if client is None:
            return
        try:
            block_id: str = rec["id"]
            topic_id: str = rec.get("topicId", "")

            # Normalise / default missing fields.
            normalised: dict[str, Any] = {
                "id": block_id,
                "topicId": topic_id,
                "type": rec.get("type", "notes"),
                "title": rec.get("title", ""),
                "content": rec.get("content", ""),
                "bbox": rec.get("bbox") or {"x": 0, "y": 0, "w": 0, "h": 0},
                "shapeIds": rec.get("shapeIds") or [],
                "updatedAt": rec.get("updatedAt") or time.time(),
            }

            pipe = client.pipeline()
            pipe.set(
                _block_key(self._session, block_id),
                json.dumps(normalised),
            )
            pipe.sadd(_index_key(self._session), block_id)
            if topic_id:
                pipe.sadd(_topic_key(self._session, topic_id), block_id)
            await pipe.execute()
        except Exception as exc:
            logger.error(f"BoardState.upsert_block failed: {exc}")
            sentry_sdk.capture_exception(exc)

    async def get_block(self, block_id: str) -> dict[str, Any] | None:
        """Return the BlockRecord for ``block_id``, or None if missing / error."""
        client = self._client_or_none()
        if client is None:
            return None
        try:
            raw = await client.get(_block_key(self._session, block_id))
            if raw is None:
                return None
            return json.loads(raw)
        except Exception as exc:
            logger.error(f"BoardState.get_block failed: {exc}")
            sentry_sdk.capture_exception(exc)
            return None

    async def remove_block(self, block_id: str) -> None:
        """Delete a block and remove it from the index and its topic set."""
        client = self._client_or_none()
        if client is None:
            return
        try:
            # Read the record first to know the topicId (needed for topic set removal).
            raw = await client.get(_block_key(self._session, block_id))
            topic_id: str | None = None
            if raw:
                try:
                    topic_id = json.loads(raw).get("topicId")
                except Exception:
                    pass  # best-effort; we still remove the key + index entry

            pipe = client.pipeline()
            pipe.delete(_block_key(self._session, block_id))
            pipe.srem(_index_key(self._session), block_id)
            if topic_id:
                pipe.srem(_topic_key(self._session, topic_id), block_id)
            await pipe.execute()
        except Exception as exc:
            logger.error(f"BoardState.remove_block failed: {exc}")
            sentry_sdk.capture_exception(exc)

    async def update_geometry(self, block_id: str, bbox: dict[str, float]) -> None:
        """Merge real post-layout geometry into an existing block (write-back path).

        Called by M4 when tldraw reports actual shape positions after ELK layout.
        Silently does nothing if the block doesn't exist yet.
        """
        client = self._client_or_none()
        if client is None:
            return
        try:
            raw = await client.get(_block_key(self._session, block_id))
            if raw is None:
                logger.debug(f"BoardState.update_geometry: block {block_id!r} not found, skipping")
                return
            rec: dict[str, Any] = json.loads(raw)
            rec["bbox"] = bbox
            rec["updatedAt"] = time.time()
            await client.set(_block_key(self._session, block_id), json.dumps(rec))
        except Exception as exc:
            logger.error(f"BoardState.update_geometry failed: {exc}")
            sentry_sdk.capture_exception(exc)

    # ------------------------------------------------------------------
    # Topic-level queries
    # ------------------------------------------------------------------

    async def get_topic_blocks(self, topic_id: str) -> list[dict[str, Any]]:
        """Return all BlockRecords belonging to ``topic_id``, in no defined order."""
        client = self._client_or_none()
        if client is None:
            return []
        try:
            block_ids: set[str] = await client.smembers(_topic_key(self._session, topic_id))
            if not block_ids:
                return []
            pipe = client.pipeline()
            for bid in block_ids:
                pipe.get(_block_key(self._session, bid))
            raws = await pipe.execute()
            results: list[dict[str, Any]] = []
            for raw in raws:
                if raw:
                    try:
                        results.append(json.loads(raw))
                    except Exception:
                        pass
            return results
        except Exception as exc:
            logger.error(f"BoardState.get_topic_blocks failed: {exc}")
            sentry_sdk.capture_exception(exc)
            return []

    # ------------------------------------------------------------------
    # Summary (board brain context injection)
    # ------------------------------------------------------------------

    async def get_state_summary(self) -> list[dict[str, Any]]:
        """Return compact dicts for every block: ``{id, topicId, type, title, summary, bbox}``.

        ``summary`` is a short snippet of the block's content (first non-blank line,
        capped at 120 chars).  Used to inject board context into the LLM system
        prompt without sending full content.
        """
        client = self._client_or_none()
        if client is None:
            return []
        try:
            block_ids: set[str] = await client.smembers(_index_key(self._session))
            if not block_ids:
                return []
            pipe = client.pipeline()
            for bid in block_ids:
                pipe.get(_block_key(self._session, bid))
            raws = await pipe.execute()
            summaries: list[dict[str, Any]] = []
            for raw in raws:
                if not raw:
                    continue
                try:
                    rec: dict[str, Any] = json.loads(raw)
                    summaries.append({
                        "id": rec.get("id", ""),
                        "topicId": rec.get("topicId", ""),
                        "type": rec.get("type", ""),
                        "title": rec.get("title", ""),
                        "summary": _summary_snippet(rec.get("content")),
                        "bbox": rec.get("bbox") or {"x": 0, "y": 0, "w": 0, "h": 0},
                    })
                except Exception:
                    pass
            return summaries
        except Exception as exc:
            logger.error(f"BoardState.get_state_summary failed: {exc}")
            sentry_sdk.capture_exception(exc)
            return []

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    async def clear(self) -> None:
        """Delete ALL keys for this session (wipes the board state)."""
        client = self._client_or_none()
        if client is None:
            return
        try:
            # Gather all block keys via the index, plus the index, active_topic, and
            # topic sets.  Use SCAN rather than KEYS for production safety, but since
            # we maintain a reliable index we can use it directly.
            block_ids: set[str] = await client.smembers(_index_key(self._session))

            # Collect topic ids from block records so we can drop topic sets too.
            topic_ids: set[str] = set()
            if block_ids:
                pipe = client.pipeline()
                for bid in block_ids:
                    pipe.get(_block_key(self._session, bid))
                raws = await pipe.execute()
                for raw in raws:
                    if raw:
                        try:
                            tid = json.loads(raw).get("topicId")
                            if tid:
                                topic_ids.add(tid)
                        except Exception:
                            pass

            keys_to_delete: list[str] = [
                _block_key(self._session, bid) for bid in block_ids
            ] + [
                _index_key(self._session),
                _active_topic_key(self._session),
            ] + [
                _topic_key(self._session, tid) for tid in topic_ids
            ]

            if keys_to_delete:
                await client.delete(*keys_to_delete)

            logger.info(f"BoardState.clear: removed {len(keys_to_delete)} keys for session={self._session!r}")
        except Exception as exc:
            logger.error(f"BoardState.clear failed: {exc}")
            sentry_sdk.capture_exception(exc)

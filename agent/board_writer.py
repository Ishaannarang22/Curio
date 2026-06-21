"""Caller channel — the board-writing brain (dual-channel voice agent).

This is the second of the two isolated brains in Curio's dual-channel design
(see HANDOFF / implementation.md). Both brains subscribe to the SAME Flux STT
transcript stream:

    AGENT channel   — bot.py's OpenAILLMService + Cartesia TTS. Talks back.
    CALLER channel  — THIS module. Never speaks. As the student explains a
                      topic out loud (Feynman technique), it cleans their words
                      into a living Markdown study doc (Wispr Flow style) and
                      writes it to the tldraw whiteboard.

Topology: BoardWriter is a pass-through FrameProcessor inserted right after the
STT service. It observes final TranscriptionFrames and does its LLM work
fire-and-forget (asyncio.create_task), so the caller's latency NEVER blocks the
speaking path — the constraint "we still want the voice agent fast". It is its
own brain with its own context (self._doc), so the two channels cannot pollute
each other.

Write path (reuses the existing whiteboard bridge, zero new infrastructure):

    BoardWriter --HTTP POST--> mock-server.js /send (:8081)
                                     |
                                     v  broadcast
                          whiteboard WS client (:8080) --> addMarkdown shape

The board renders the Markdown as one auto-growing, Notion-style "markdown-doc"
shape (whiteboard/src/shapes/MarkdownDoc.tsx). We address it with a stable id
so each turn UPDATES the same doc in place instead of stacking new ones.

Isolation / config: the caller is a separate "brain", resolved independently of
the speaker (prefers Claude Haiku via the Vercel AI Gateway — fastest/cheapest
with tool-use + streaming — and falls back to whatever brain the speaker uses).
If no brain key and no board bridge are configured, BoardWriter quietly
disables itself: the voice pipeline still runs fully.
"""

import asyncio
import os
from typing import Any

import httpx
import sentry_sdk
from loguru import logger

from pipecat.frames.frames import TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

# Default doc id — a stable key so addMarkdown updates ONE growing doc in place
# (boardApi.addMarkdown does updateShape when the id already exists).
_DEFAULT_DOC_ID = "live"
_DEFAULT_SEND_URL = "http://localhost:8081/send"

# System prompt for the caller brain. It owns the whole job in one shot:
# read its prior doc (passed in as context) -> integrate the new spoken words
# -> return the full cleaned doc. No separate downstream formatter.
_CALLER_SYSTEM_PROMPT = (
    "You maintain a single, clean, well-structured Markdown study document that "
    "is being built live while a student explains a topic out loud (the Feynman "
    "technique). You are given the CURRENT document and the student's LATEST "
    "spoken words (raw, possibly disfluent, with filler and false starts).\n\n"
    "Return the FULL updated Markdown document with the new material integrated "
    "as clean notes — the way Wispr Flow cleans up live dictation:\n"
    "- Remove filler ('um', 'like', 'you know'), false starts, and repetition.\n"
    "- Organize with headings, **bold** key terms, bullet/numbered lists, and "
    "tables where they fit naturally. Keep it tight and scannable.\n"
    "- Continue the existing structure when the student keeps the same thread; "
    "start a new section when they move to a new sub-topic.\n"
    "- Never invent facts the student didn't say. Don't add commentary.\n\n"
    "Output ONLY the Markdown document — no preamble, no code fences around the "
    "whole thing, no explanation."
)


def _resolve_caller_config() -> dict[str, str] | None:
    """Resolve an OpenAI-compatible endpoint for the caller brain.

    Mirrors bot.py's _resolve_llm precedence, but PREFERS Claude Haiku over the
    Vercel AI Gateway (cheap + fast + streaming + tool use). Returns None when no
    brain key is configured, which disables the caller channel.
    """
    gateway_key = os.getenv("AI_GATEWAY_API_KEY")
    nvidia_key = os.getenv("NVIDIA_API_KEY")
    zai_key = os.getenv("ZAI_API_KEY")

    if gateway_key:
        # Vercel AI Gateway exposes 280+ models behind one key; reach Haiku via
        # its provider/model slug. Override with CALLER_MODEL if the slug differs.
        return {
            "base_url": "https://ai-gateway.vercel.sh/v1",
            "api_key": gateway_key,
            "model": os.getenv("CALLER_MODEL", "anthropic/claude-haiku-4-5"),
        }
    if nvidia_key:
        return {
            "base_url": os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
            "api_key": nvidia_key,
            "model": os.getenv("CALLER_MODEL")
            or os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-super-120b-a12b"),
        }
    if zai_key:
        return {
            "base_url": os.getenv("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4/"),
            "api_key": zai_key,
            "model": os.getenv("CALLER_MODEL") or os.getenv("ZAI_MODEL", "glm-5.1"),
        }
    return None


class BoardWriter(FrameProcessor):
    """Pass-through processor that mirrors the student's speech to the board.

    Insert it right after the STT service. It forwards every frame untouched
    (so turn-taking, interruption, and persistence are unaffected) and, on each
    final TranscriptionFrame, fires a non-blocking task that:
      1. asks the caller brain to fold the new words into the running doc, then
      2. POSTs the updated Markdown to the whiteboard bridge.

    An asyncio.Lock serializes those tasks so update N+1 sees update N's doc
    (read-after-write ordering), and so we never race self._doc.
    """

    def __init__(
        self,
        *,
        send_url: str | None = None,
        doc_id: str = _DEFAULT_DOC_ID,
    ):
        super().__init__()
        self._send_url = send_url or os.getenv("WHITEBOARD_SEND_URL", _DEFAULT_SEND_URL)
        self._doc_id = doc_id
        self._config = _resolve_caller_config()
        self._enabled = self._config is not None
        self._doc = ""  # the caller brain's own memory of what it has written
        self._lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()
        self._client = httpx.AsyncClient(timeout=20)

        if self._enabled:
            logger.info(
                f"BoardWriter (caller channel) enabled: model={self._config['model']}, "
                f"board={self._send_url}"
            )
        else:
            logger.warning(
                "BoardWriter disabled: no caller brain key "
                "(AI_GATEWAY_API_KEY / NVIDIA_API_KEY / ZAI_API_KEY). "
                "Voice pipeline runs normally; nothing is written to the board."
            )

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        # Final user transcript (Flux EndOfTurn). Interim frames are ignored.
        if (
            self._enabled
            and direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, TranscriptionFrame)
        ):
            text = (frame.text or "").strip()
            if text:
                self._spawn(self._handle_utterance(text))

        # ALWAYS forward — the caller channel is an observer, never a sink.
        await self.push_frame(frame, direction)

    def _spawn(self, coro):
        """Fire-and-forget, keeping a strong ref so the task isn't GC'd."""
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _handle_utterance(self, text: str):
        """Format the new words into the running doc and push it to the board.

        Serialized by self._lock so turns commit in order and the brain always
        formats against its latest doc. Never raises — a failed caller write can
        never disturb the speaking channel.
        """
        async with self._lock:
            try:
                updated = await self._format(self._doc, text)
                if not updated.strip():
                    return
                self._doc = updated
                await self._push_to_board(updated)
            except Exception as e:
                logger.error(f"BoardWriter update failed: {e}")
                sentry_sdk.capture_exception(e)

    async def _format(self, current_doc: str, utterance: str) -> str:
        """One-shot caller LLM call: current doc + new words -> full new doc."""
        assert self._config is not None
        user_content = (
            f"CURRENT DOCUMENT:\n{current_doc or '(empty — start a new document)'}\n\n"
            f"STUDENT'S LATEST SPOKEN WORDS:\n{utterance}"
        )
        resp = await self._client.post(
            f"{self._config['base_url'].rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {self._config['api_key']}"},
            json={
                "model": self._config["model"],
                "messages": [
                    {"role": "system", "content": _CALLER_SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                "temperature": 0.3,
                "max_tokens": 1500,
            },
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return (data["choices"][0]["message"]["content"] or "").strip()

    async def _push_to_board(self, markdown: str):
        """Broadcast an addMarkdown command through the whiteboard bridge."""
        try:
            await self._client.post(
                self._send_url,
                json={
                    "action": "addMarkdown",
                    "payload": {"id": self._doc_id, "markdown": markdown},
                },
            )
        except Exception as e:
            # The board bridge may simply not be running (voice-only session).
            # Log once at debug volume; never escalate to the speaking path.
            logger.debug(f"BoardWriter could not reach the board bridge: {e}")

    async def close(self):
        """Let in-flight writes finish briefly, then close the HTTP client."""
        if self._tasks:
            await asyncio.wait(self._tasks, timeout=5)
        await self._client.aclose()

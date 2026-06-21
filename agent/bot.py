"""Realtime voice agent (pipecat 1.3.0).

A genericized, observability-first voice orchestration layer: Deepgram Flux for
STT + semantic turn-taking, an OpenAI-compatible LLM brain, and Cartesia
Sonic-3 TTS, glued together with human-feeling interruption handling. Every
naturalness knob lives in tuning.py; every error/trace flows to Sentry.

PIPELINE (one session = one browser peer connection = one bot() invocation):

    transport.input()            SmallWebRTC audio in from the browser mic
        |
    DeepgramFluxSTTService       STT + semantic turn-taking in one service.
        |                        Flux itself decides when the user starts a
        |                        turn (StartOfTurn) and when the turn is over
        |                        (EndOfTurn, scored semantically against
        |                        FLUX_EOT_THRESHOLD). It emits:
        |                          - UserStartedSpeakingFrame  (StartOfTurn)
        |                          - InterimTranscriptionFrame (EagerEOT, plus
        |                            our bridged "Update" events — see below)
        |                          - TranscriptionFrame + UserStoppedSpeakingFrame
        |                            (EndOfTurn, final transcript)
        |                        We pass should_interrupt=False so Flux does
        |                        NOT hard-interrupt the bot on every noise —
        |                        interruption is governed by the min-words
        |                        strategy in the user aggregator instead.
        |
    ctx_aggregators.user()       Aggregates the user's turn into the shared
        |                        LLMContext and runs the turn controller:
        |                          start: MinWordsUserTurnStartStrategy
        |                            - bot speaking  -> needs >= BACKCHANNEL_MIN_WORDS
        |                              words before the turn starts AND the bot
        |                              is interrupted (backchannels like "yeah",
        |                              "mm-hmm" never reach the threshold; they
        |                              are absorbed, never interrupt, never get
        |                              persisted or sent to the LLM)
        |                            - bot silent    -> 1 word starts the turn
        |                          stop: ExternalUserTurnStopStrategy
        |                            - finalizes the turn when Flux's
        |                              UserStoppedSpeakingFrame (EndOfTurn)
        |                              arrives (+ a short settle window)
        |                        On turn stop it triggers LLM inference and
        |                        fires on_user_turn_stopped -> we persist the
        |                        final user utterance.
        |
    OpenAILLMService             OpenAI-compatible chat completions. Either
        |                        Vercel AI Gateway (AI_GATEWAY_API_KEY set,
        |                        model from the session payload), NVIDIA NIM,
        |                        or any OpenAI-compatible endpoint (ZAI_*).
        |
    CartesiaTTSService           Streams the reply as audio (voice/speed/
        |                        emotion knobs in tuning.py).
        |
    transport.output()           SmallWebRTC audio out to the browser.
        |
    ctx_aggregators.assistant()  Adds the spoken reply to the LLMContext and
                                 fires on_assistant_turn_stopped -> we persist
                                 the completed assistant turn.

INTERRUPTION FLOW:
    User talks while bot talks -> Flux "Update" events stream partial text ->
    we bridge them to InterimTranscriptionFrame (INTERRUPT_ON_PARTIAL_TRANSCRIPTS)
    -> MinWordsUserTurnStartStrategy counts words -> at >= BACKCHANNEL_MIN_WORDS
    the user aggregator broadcasts an interruption -> TTS audio is cut and the
    in-flight LLM/TTS turn is cancelled (hard cut; pipecat 1.3.0 has no
    graceful fade-out). Because hearing N words takes ~300-800ms, a natural
    overlap window is built in. Below the threshold, nothing happens: the bot
    keeps talking and the fragment is discarded (trigger_reset_aggregation).

PERSISTENCE FLOW (RLS-safe, fire-and-forget, optional):
    If the session payload carries Supabase credentials, on_user_turn_stopped /
    on_assistant_turn_stopped schedule a non-blocking POST to
    {supabaseUrl}/rest/v1/messages with the user's own access token
    (Authorization: Bearer) + anon apikey, so Supabase RLS sees the actual
    user. Errors are logged and reported to Sentry, never raised, never block
    audio. Without credentials, persistence is simply skipped (the orchestration
    layer still runs fully). The opener is NOT persisted here — whoever created
    the conversation server-side is expected to have inserted it.

OBSERVABILITY:
    Sentry is initialized at process start when SENTRY_DSN is set (see
    _init_sentry). The loguru integration forwards log records as breadcrumbs
    (INFO+) and events (ERROR+) automatically, and we explicitly
    capture_exception around the session run and persistence writes. Per-session
    tags (model, conversation id) are attached so events are filterable.

CLIENT TRANSCRIPTS:
    PipelineWorker auto-installs an RTVIProcessor + RTVIObserver
    (enable_rtvi=True default in pipecat 1.3.0), which sends user/bot
    transcription RTVI events over the WebRTC data channel — a web client can
    render live captions from those.

SESSION HANDSHAKE (contract with a future client):
    The browser POSTs its WebRTC offer to http://localhost:7860/api/offer as
    JSON: { sdp, type, request_data: { session: {...} } }   (the runner also
    accepts the key "requestData"; pipecat client-js sends this via the
    `requestData` option on its SmallWebRTC transport connection params).
    The runner passes request_data straight to this bot as runner_args.body,
    so the payload is read from runner_args.body["session"]:
    { conversationId, accessToken, supabaseUrl, supabaseAnonKey,
      systemPrompt, opener, model }.
"""

import asyncio
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse
from typing import Any

import httpx
import sentry_sdk
from dotenv import load_dotenv
from loguru import logger
from sentry_sdk.integrations.loguru import LoguruIntegration

from pipecat.frames.frames import InterimTranscriptionFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import TransportParams
from pipecat.turns.user_start.min_words_user_turn_start_strategy import (
    MinWordsUserTurnStartStrategy,
)
from pipecat.turns.user_stop.external_user_turn_stop_strategy import (
    ExternalUserTurnStopStrategy,
)
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.time import time_now_iso8601
from pipecat.workers.runner import WorkerRunner

import tuning
from board_writer import BoardWriter

# Load env from agent/.env (optional) AND the repo root .env.local, so the
# keys already configured for the Next.js app (DEEPGRAM_API_KEY,
# CARTESIA_API_KEY, the LLM keys, SENTRY_DSN) just work here too.
_AGENT_DIR = Path(__file__).resolve().parent
load_dotenv(_AGENT_DIR / ".env")
load_dotenv(_AGENT_DIR.parent / ".env.local")
_MAX_OFFER_BODY_BYTES = 256 * 1024


# -----------------------------------------------------------------------------
# Observability — Sentry (errors + tracing). No-op when SENTRY_DSN is unset.
# -----------------------------------------------------------------------------


def _init_sentry() -> bool:
    """Initialize Sentry if a DSN is configured. Returns True when enabled.

    The loguru integration forwards log records automatically: INFO+ as
    breadcrumbs, ERROR+ as captured events — so every logger.error() in this
    file lands in Sentry without an explicit capture call.
    """
    dsn = os.getenv("SENTRY_DSN") or os.getenv("NEXT_PUBLIC_SENTRY_DSN")
    if not dsn:
        logger.info("Sentry disabled (no SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN).")
        return False

    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("SENTRY_ENVIRONMENT", "development"),
        # 1.0 captures every transaction. Lower (~0.1) in production.
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "1.0")),
        integrations=[LoguruIntegration()],
        send_default_pii=False,
    )
    sentry_sdk.set_tag("service", "voice-agent")
    logger.info("Sentry enabled for the voice agent.")
    return True


# -----------------------------------------------------------------------------
# Supabase persistence (RLS-safe, fire-and-forget, optional)
# -----------------------------------------------------------------------------


class MessageStore:
    """Persists finalized turns to Supabase PostgREST with the user's own JWT.

    Every write goes to {supabase_url}/rest/v1/messages with the anon apikey
    plus the end-user's access token, so row-level security policies apply
    exactly as if the browser had written the row itself. The expected table
    shape is (conversation_id, role, content).

    Writes are fire-and-forget (asyncio.create_task): a slow or failing
    insert can never stall the audio pipeline. Failures are logged and reported
    to Sentry.
    """

    def __init__(
        self,
        *,
        supabase_url: str,
        anon_key: str,
        access_token: str,
        conversation_id: str,
    ):
        self._endpoint = f"{supabase_url.rstrip('/')}/rest/v1/messages"
        self._headers = {
            "apikey": anon_key,
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }
        self._conversation_id = conversation_id
        self._client = httpx.AsyncClient(timeout=10)
        self._tasks: set[asyncio.Task] = set()

    def persist(self, role: str, content: str):
        """Schedule a non-blocking insert of one message row."""
        task = asyncio.create_task(self._post(role, content))
        # Keep a strong reference so the task isn't garbage-collected mid-flight.
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _post(self, role: str, content: str):
        try:
            response = await self._client.post(
                self._endpoint,
                headers=self._headers,
                json={
                    "conversation_id": self._conversation_id,
                    "role": role,
                    "content": content,
                },
            )
            if response.status_code >= 400:
                logger.error(
                    f"Message persistence failed ({role}): "
                    f"HTTP {response.status_code} {response.text[:300]}"
                )
        except Exception as e:
            logger.error(f"Message persistence failed ({role}): {e}")
            sentry_sdk.capture_exception(e)

    async def close(self):
        """Let in-flight writes finish (briefly), then close the HTTP client."""
        if self._tasks:
            await asyncio.wait(self._tasks, timeout=5)
        await self._client.aclose()


# -----------------------------------------------------------------------------
# LLM resolution: Vercel AI Gateway > NVIDIA NIM > any OpenAI-compatible (ZAI_*)
# -----------------------------------------------------------------------------


_SPEECH_MARKUP = re.compile(
    r"<break\s[^>]*/?>|<emotion\s[^>]*/?>|\[(?:laughter|laughs|sighs?)\]",
    re.IGNORECASE,
)


def _strip_speech_markup(text: str) -> str:
    """Remove TTS-only markup so transcripts read as prose."""
    return re.sub(r"\s{2,}", " ", _SPEECH_MARKUP.sub(" ", text)).strip()


def _resolve_llm(payload_model: str | None) -> OpenAILLMService:
    extra: dict[str, Any] = {}
    gateway_key = os.getenv("AI_GATEWAY_API_KEY")
    nvidia_key = os.getenv("NVIDIA_API_KEY")

    if gateway_key:
        model = _allowed_model(payload_model, os.getenv("AI_GATEWAY_MODEL") or "openai/gpt-4o-mini")
        base_url = "https://ai-gateway.vercel.sh/v1"
        api_key = gateway_key
        logger.info(f"LLM: Vercel AI Gateway, model={model}")
    elif nvidia_key:
        base_url = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
        api_key = nvidia_key
        model = os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-super-120b-a12b")
        # Nemotron 3 reasons by default, which adds seconds of dead air
        # before the first spoken token. Voice needs the instinctive reply.
        # Settings.extra is splatted into the OpenAI SDK's create() call, so
        # non-standard params must ride in extra_body (the SDK rejects
        # unknown top-level kwargs).
        extra = {"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}}
        logger.info(f"LLM: NVIDIA NIM ({base_url}), model={model}, thinking off")
    else:
        base_url = os.getenv("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4/")
        api_key = os.getenv("ZAI_API_KEY", "")
        model = os.getenv("ZAI_MODEL", "glm-5.1")
        logger.info(f"LLM: OpenAI-compatible ({base_url}), model={model}")

    sentry_sdk.set_tag("llm.model", model)
    return OpenAILLMService(
        api_key=api_key,
        base_url=base_url,
        settings=OpenAILLMService.Settings(model=model, extra=extra),
    )


def _allowed_model(requested_model: str | None, default_model: str) -> str:
    allowed = {
        m.strip()
        for m in os.getenv("ALLOWED_LLM_MODELS", default_model).split(",")
        if m.strip()
    }
    if requested_model and requested_model in allowed:
        return requested_model
    if requested_model and requested_model not in allowed:
        logger.warning(f"Rejected unapproved model from session payload: {requested_model!r}")
    return default_model


def _is_allowed_supabase_url(url: str) -> bool:
    configured = os.getenv("SUPABASE_URL")
    if configured:
        return url.rstrip("/") == configured.rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False
    return parsed.hostname is not None and parsed.hostname.endswith(".supabase.co")


# -----------------------------------------------------------------------------
# Bot entry point — invoked by the pipecat dev runner per WebRTC session
# -----------------------------------------------------------------------------


async def bot(runner_args: RunnerArguments):
    """Build and run one voice session."""
    transport = await create_transport(
        runner_args,
        {
            "webrtc": lambda: TransportParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
            ),
        },
    )

    # --- Session payload from the browser (see module docstring: it arrives
    # --- as request_data on POST /api/offer and lands in runner_args.body).
    body: dict[str, Any] = runner_args.body if isinstance(runner_args.body, dict) else {}
    session_ctx: dict[str, Any] = body.get("session") or {}
    if not session_ctx:
        logger.warning(
            "No `session` payload in the connect request (runner_args.body['session']); "
            "running with fallback prompt and no persistence (dev /client UI?)."
        )

    system_prompt = session_ctx.get("systemPrompt") or (
        "You are a warm, natural voice companion having a real-time spoken "
        "conversation. Keep replies to one to three short spoken sentences."
    )
    opener = session_ctx.get("opener")

    # --- Persistence (only when the client provided full Supabase credentials).
    store: MessageStore | None = None
    if all(
        session_ctx.get(k)
        for k in ("conversationId", "accessToken", "supabaseUrl", "supabaseAnonKey")
    ) and _is_allowed_supabase_url(str(session_ctx["supabaseUrl"])):
        store = MessageStore(
            supabase_url=session_ctx["supabaseUrl"],
            anon_key=session_ctx["supabaseAnonKey"],
            access_token=session_ctx["accessToken"],
            conversation_id=session_ctx["conversationId"],
        )
        sentry_sdk.set_tag("conversation.id", session_ctx["conversationId"])
    else:
        logger.warning("Persistence disabled: missing Supabase credentials in payload.")

    # --- STT + semantic end-of-turn: Deepgram Flux.
    # should_interrupt=False: Flux must not hard-interrupt the bot on every
    # StartOfTurn — backchannel tolerance is handled by the min-words strategy.
    flux_settings_kwargs: dict[str, Any] = {
        "model": tuning.FLUX_MODEL,
        "eot_threshold": tuning.FLUX_EOT_THRESHOLD,
        "eot_timeout_ms": tuning.FLUX_EOT_TIMEOUT_MS,
    }
    if tuning.FLUX_EAGER_EOT_THRESHOLD is not None:
        flux_settings_kwargs["eager_eot_threshold"] = tuning.FLUX_EAGER_EOT_THRESHOLD
    stt = DeepgramFluxSTTService(
        api_key=os.getenv("DEEPGRAM_API_KEY", ""),
        should_interrupt=False,
        settings=DeepgramFluxSTTService.Settings(**flux_settings_kwargs),
    )

    if tuning.INTERRUPT_ON_PARTIAL_TRANSCRIPTS:
        # Flux streams partial text mid-turn only through its "Update" event
        # (not as pipeline frames). Bridge those updates into
        # InterimTranscriptionFrame so MinWordsUserTurnStartStrategy can count
        # words WHILE the user is still talking and yield with human-like
        # overlap instead of waiting for Flux's EndOfTurn.
        @stt.event_handler("on_update")
        async def _on_flux_update(service: DeepgramFluxSTTService, transcript: str):
            if transcript:
                await service.push_frame(
                    InterimTranscriptionFrame(transcript, "", time_now_iso8601())
                )

    # --- LLM (OpenAI-compatible).
    llm = _resolve_llm(session_ctx.get("model"))

    # --- TTS: Cartesia, warm/calm voice; all knobs in tuning.py.
    tts = CartesiaTTSService(
        api_key=os.getenv("CARTESIA_API_KEY", ""),
        settings=CartesiaTTSService.Settings(
            voice=tuning.TTS_VOICE_ID,
            model=tuning.TTS_MODEL,
            generation_config=GenerationConfig(
                speed=tuning.TTS_SPEED,
                volume=tuning.TTS_VOLUME,
                emotion=tuning.TTS_EMOTION,
            ),
        ),
    )

    # --- Conversation context. The opener is seeded as the first assistant
    # --- message (whoever created the conversation already persisted it).
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    if opener:
        messages.append({"role": "assistant", "content": opener})
    context = LLMContext(messages=messages)

    # --- Turn-taking + backchannel tolerance (see module docstring).
    user_turn_strategies = UserTurnStrategies(
        # Start/interrupt: needs >= BACKCHANNEL_MIN_WORDS while the bot speaks,
        # 1 word while it is silent. enable_user_speaking_frames=False because
        # Flux already emits UserStartedSpeaking/UserStoppedSpeaking frames.
        start=[
            MinWordsUserTurnStartStrategy(
                min_words=tuning.BACKCHANNEL_MIN_WORDS,
                use_interim=True,
                enable_interruptions=tuning.ALLOW_INTERRUPTIONS,
                enable_user_speaking_frames=False,
            )
        ],
        # Stop: trust Flux's semantic EndOfTurn (UserStoppedSpeakingFrame),
        # with a short settle window for straggler transcripts.
        stop=[ExternalUserTurnStopStrategy(timeout=tuning.USER_TURN_SETTLE_SECS)],
    )
    ctx_aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=user_turn_strategies,
            user_turn_stop_timeout=tuning.USER_TURN_STOP_TIMEOUT_SECS,
        ),
    )

    # --- Caller channel: the board-writing brain (dual-channel design).
    # A pass-through observer of final transcripts. Its own isolated brain +
    # context; fire-and-forget so it never blocks the speaking path. Writes
    # structured artifacts (Phase 1–3) to the tldraw whiteboard via the bridge.
    # Self-disables (voice runs untouched) when no caller key / board bridge.
    # M3: pass session (conversationId) for Redis namespacing.
    board_writer = BoardWriter(session=session_ctx.get("conversationId") or "default")

    pipeline = Pipeline(
        [
            transport.input(),  # browser mic audio (SmallWebRTC)
            stt,  # Deepgram Flux: STT + end-of-turn
            board_writer,  # CALLER channel: mirror speech -> whiteboard (observer)
            ctx_aggregators.user(),  # user turn -> context (+ turn controller)
            llm,  # OpenAI-compatible chat completion
            tts,  # Cartesia speech synthesis
            transport.output(),  # bot audio to browser
            ctx_aggregators.assistant(),  # assistant turn -> context
        ]
    )

    # PipelineWorker auto-adds RTVIProcessor + RTVIObserver (enable_rtvi=True
    # default), which streams live user/bot transcription events to the web
    # client over the data channel.
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True),
        idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
    )

    # --- Persistence hooks: finalized turns only.
    if store:

        @ctx_aggregators.user().event_handler("on_user_turn_stopped")
        async def _persist_user_turn(aggregator, strategy, message):
            if message.content and message.content.strip():
                store.persist("user", message.content.strip())

        @ctx_aggregators.assistant().event_handler("on_assistant_turn_stopped")
        async def _persist_assistant_turn(aggregator, message):
            # Persist what was actually said — pipecat aggregates only the
            # text spoken before any interruption. Empty turns are skipped.
            # Speech markup (<break/>, [laughter]) is for the TTS engine, not
            # the written transcript.
            if message.content and message.content.strip():
                store.persist("assistant", _strip_speech_markup(message.content))

    # --- Lifecycle.
    @transport.event_handler("on_client_connected")
    async def _on_client_connected(transport, client):
        logger.info("Client connected")
        if opener and tuning.SPEAK_OPENER:
            # Voice the opener directly through TTS. It bypasses the LLM, so
            # the assistant aggregator does NOT re-add or re-persist it — it
            # is already in the seeded context.
            await worker.queue_frames([TTSSpeakFrame(opener)])

    @transport.event_handler("on_client_disconnected")
    async def _on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    try:
        with sentry_sdk.start_transaction(op="voice.session", name="voice.session"):
            await runner.run(worker)
    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise
    finally:
        await board_writer.close()
        if store:
            await store.close()


class _OfferBodyCompat:
    """Rewrites camelCase `requestData` to snake_case `request_data` on
    POST /api/offer.

    pipecat 1.3.0's direct offer route parses the body into the
    SmallWebRTCRequest dataclass, whose field is `request_data` — but
    pipecat client-js always sends `requestData`, so the custom payload
    (our `session` context) is silently dropped. The camelCase-aware
    `from_dict` is only used on the session-proxy path. Until upstream
    fixes the direct path, normalize the key before FastAPI parses it.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] == "http"
            and scope.get("method") == "POST"
            and scope.get("path", "").endswith("/api/offer")
        ):
            body = b""
            more = True
            while more:
                message = await receive()
                body += message.get("body", b"")
                if len(body) > _MAX_OFFER_BODY_BYTES:
                    await send({
                        "type": "http.response.start",
                        "status": 413,
                        "headers": [(b"content-type", b"text/plain")],
                    })
                    await send({
                        "type": "http.response.body",
                        "body": b"Request too large",
                    })
                    return
                more = message.get("more_body", False)
            try:
                data = json.loads(body or b"{}")
                if "requestData" in data and "request_data" not in data:
                    data["request_data"] = data.pop("requestData")
                body = json.dumps(data).encode()
            except (ValueError, TypeError):
                pass  # not JSON — let the route reject it

            # Keep content-length consistent with the rewritten body.
            scope = dict(scope)
            scope["headers"] = [
                (k, v) for k, v in scope["headers"] if k != b"content-length"
            ] + [(b"content-length", str(len(body)).encode())]

            replayed = False

            async def replay():
                nonlocal replayed
                if not replayed:
                    replayed = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            await self.app(scope, replay, send)
        else:
            await self.app(scope, receive, send)


def _patch_stun_servers():
    """Give every WebRTC connection STUN servers for NAT traversal.

    The dev runner constructs its SmallWebRTCRequestHandler without
    ice_servers, so connections only gather host candidates — remote users
    (e.g. coming in through a tunnel) can never establish the audio path.
    Defaulting the handler's ice_servers fixes that without forking run.py.
    """
    from pipecat.transports.smallwebrtc.connection import IceServer
    from pipecat.transports.smallwebrtc.request_handler import (
        SmallWebRTCRequestHandler,
    )

    if not tuning.ICE_STUN_URLS:
        return
    stun = [IceServer(urls=[url]) for url in tuning.ICE_STUN_URLS]
    orig_init = SmallWebRTCRequestHandler.__init__

    def init_with_stun(self, *args, **kwargs):
        if not kwargs.get("ice_servers"):
            kwargs["ice_servers"] = stun
        orig_init(self, *args, **kwargs)

    SmallWebRTCRequestHandler.__init__ = init_with_stun


if __name__ == "__main__":
    from pipecat.runner.run import main, app as runner_app

    _init_sentry()
    runner_app.add_middleware(_OfferBodyCompat)
    _patch_stun_servers()

    # Serves the SmallWebRTC offer endpoint at POST http://localhost:7860/api/offer
    # (CORS is open — allow_origins=["*"] in the dev runner — so a Next.js
    # app on http://localhost:3000 can call it directly).
    main()

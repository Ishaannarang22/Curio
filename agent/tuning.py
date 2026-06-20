"""Every naturalness "weight" for the voice agent, in one place.

These knobs decide whether the agent feels like a patient human listener or a
walkie-talkie. They are read by bot.py at session start (restart the agent
after changing them).

A note on overlap (the core of "natural"):
Humans routinely talk over each other for 200-2500ms before one party yields.
The agent reproduces this with BACKCHANNEL_MIN_WORDS: while the agent is
speaking, the user must utter at least that many words before the agent yields.
Hearing those words takes real time (~300-800ms of speech for 3 words), so a
short window of natural overlap is *built in* — the agent keeps talking through
"yeah", "mm-hmm", "right", laughter... and only yields to a real interjection.

A note on yielding style:
When the agent does yield, pipecat 1.3.0 performs a hard interruption (audio
output is cut immediately, the in-flight LLM/TTS turn is cancelled). There is
no graceful fade-out / trail-off mechanism in this pipecat version, so a hard
cut is what you get; the min-words overlap above is what keeps it from
feeling robotic.
"""

# =============================================================================
# INTERRUPTIONS / BACKCHANNEL TOLERANCE
# =============================================================================

# Master switch. If False, the agent always finishes what it is saying; the
# user's words are still transcribed and answered afterwards. Keep True for
# natural conversation.
ALLOW_INTERRUPTIONS = True

# While the agent is SPEAKING, the user must say at least this many words before
# the agent stops and yields. Short acknowledgments ("yeah", "okay", "so true",
# laughter) stay below the threshold and do NOT interrupt — they are simply
# absorbed (they are also not persisted, and not sent to the LLM).
# While the agent is SILENT, a single word starts the user's turn (this is
# hardcoded behavior of pipecat's MinWordsUserTurnStartStrategy).
#   2 = hair-trigger (even "but wait" cuts the agent off)
#   3 = good default (~300-800ms of natural overlap before yielding)
#   5 = very patient (the user has to commit to a full sentence)
BACKCHANNEL_MIN_WORDS = 3

# Deepgram Flux only delivers transcript text mid-turn via its "Update"
# events (its in-pipeline frames arrive at end of turn). When True, bot.py
# bridges those Update events into interim transcription frames so the
# min-words counter can fire WHILE the user is still talking — the agent yields
# a beat after the user crosses the word threshold (human-like overlap).
# When False, the agent only yields once Flux declares the user's turn over,
# i.e. the agent talks through the entire interjection before stopping (overlap
# up to a few seconds — usually too sluggish, but useful for comparison).
INTERRUPT_ON_PARTIAL_TRANSCRIPTS = True

# =============================================================================
# END-OF-TURN DETECTION (Deepgram Flux semantic turn-taking)
# This is the difference between "cuts you off mid-thought" and "responds
# snappily". Flux scores how *finished* an utterance sounds, semantically.
# =============================================================================

# Confidence Flux needs before declaring the user's turn over (0..1).
#   lower  (0.5)  -> snappier replies, more risk of jumping in mid-thought
#   higher (0.85) -> very patient, but replies feel laggy after short answers
FLUX_EOT_THRESHOLD = 0.7

# Optional "eager" end-of-turn threshold (0..1) — must be LOWER than
# FLUX_EOT_THRESHOLD. When set, Flux emits early maybe-finished transcripts,
# shaving latency at the cost of extra LLM traffic. None = disabled (default).
# Try 0.5 if replies feel slow.
FLUX_EAGER_EOT_THRESHOLD = None

# Hard ceiling: after this much silence (ms) the turn ends regardless of
# semantic confidence. Big values let people pause and think mid-sentence
# without being talked over.
FLUX_EOT_TIMEOUT_MS = 5000

# Deepgram Flux model. "flux-general-en" is English-tuned; use
# "flux-general-multi" for multilingual conversations.
FLUX_MODEL = "flux-general-en"

# =============================================================================
# TURN PLUMBING (rarely needs touching)
# =============================================================================

# After Flux says "turn over", the stop strategy waits this long (seconds)
# for any straggler transcription before finalizing the user's turn and
# triggering the LLM. This is pure added latency on EVERY reply — keep it
# just high enough that the tail of the transcript never gets dropped.
USER_TURN_SETTLE_SECS = 0.3

# Watchdog: if a user turn somehow starts but never cleanly stops, force-stop
# it after this many seconds of no activity so the conversation can't wedge.
USER_TURN_STOP_TIMEOUT_SECS = 5.0

# =============================================================================
# VOICE (Cartesia TTS)
# =============================================================================

# Cartesia voice id. Default: "Tessa - Kind Companion"
# (6ccbfb76-1fc6-48f7-b71d-91ac6298247b) — warm conversational female AND on
# Cartesia's emotive-recommended list, so the `emotion` guidance below and
# the LLM's inline prosody markup (<break/>, [laughter]) land with real
# dynamic range. Non-emotive voices read everything in one flat cadence.
# Emotive alternatives (paste any id):
#   cbaf8084-f009-4838-a096-07ee2e6612b1  Maya - Easygoing Ally (casual, lighter)
#   cc00e582-ed66-4004-8336-0175b85c85f6  Dana - Balanced Spirit (calm, neutral)
# Conversational but NOT emotive-recommended:
#   e07c00bc-4134-4eae-9ea4-1a55fb45746b  Brooke - Big Sister (confident)
#   e8e5fffb-252c-436d-b842-8879b84445b6  Cathy - Coworker (casual, peer-like)
# Browse https://play.cartesia.ai/voices for more.
TTS_VOICE_ID = "6ccbfb76-1fc6-48f7-b71d-91ac6298247b"

# Cartesia TTS model.
TTS_MODEL = "sonic-3"

# Speaking-rate multiplier, valid 0.6 - 1.5. 1.0 keeps conversational energy;
# below ~0.92 dialogue voices start to drag and feel synthetic.
TTS_SPEED = 1.0

# Loudness multiplier, valid 0.5 - 2.0.
TTS_VOLUME = 1.0

# Optional single emotion hint for Sonic-3 (e.g. "content", "calm", "warm",
# "sad"). CAUTION: this is applied to EVERY sentence of the session — a soft
# value here makes the agent coo at small talk like it's consoling someone.
# Leave None and let delivery follow the words: Sonic-3 infers emotion from
# what the LLM writes.
TTS_EMOTION = None

# =============================================================================
# NETWORKING
# =============================================================================

# STUN servers for WebRTC NAT traversal. Without these, the agent only offers
# its local network addresses — fine on localhost, impossible for anyone on
# the internet. Required when serving remote users (e.g. through a tunnel).
ICE_STUN_URLS = ["stun:stun.l.google.com:19302"]

# =============================================================================
# SESSION BEHAVIOR
# =============================================================================

# Speak the server-provided opener line as soon as the client connects.
# The opener is seeded into the LLM context as the first assistant message
# either way (so the model knows it already greeted the user); this knob only
# controls whether it is voiced aloud.
SPEAK_OPENER = True

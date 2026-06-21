'use client'

/**
 * VoiceConnect — floating mic button that connects the browser to the Curio
 * Pipecat voice agent running at NEXT_PUBLIC_VOICE_AGENT_URL (default :7860).
 *
 * Flow:
 *   1. User clicks "Talk" → we POST a WebRTC offer to :7860/api/offer with
 *      requestData = { session: { conversationId: <session> } }.
 *   2. SmallWebRTCTransport completes the ICE handshake with the Pipecat runner.
 *   3. Mic audio flows to the agent; TTS audio plays back in the browser.
 *   4. The agent's BoardWriter issues tool calls → BridgePoster POSTs to
 *      :3000/api/board/send → SSE stream → commandQueue → tldraw board.
 *
 * No secrets are sent client-side. The NEXT_PUBLIC_VOICE_AGENT_URL is the only
 * cross-origin call (Pipecat runner has open CORS in dev).
 *
 * NOTE: mic→agent→board loop cannot be verified without a running agent
 * and a real microphone. This component compiles and renders correctly.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { PipecatClient } from '@pipecat-ai/client-js'
import { SmallWebRTCTransport } from '@pipecat-ai/small-webrtc-transport'
import { Orb, type OrbState } from './Orb'
import './orb.css'

type Status = 'idle' | 'connecting' | 'live' | 'error'

/**
 * Pipecat's onError hands us an RTVI message object — `{ data: { error, fatal } }`
 * — not a string. Naive `String(message)` yields "[object Object]" and treating
 * every onError as fatal would knock a healthy live session into the error state
 * on benign server notices. Extract a readable message + the `fatal` flag so the
 * UI only tears down on real failures.
 */
function parseAgentError(message: unknown): { text: string; fatal: boolean } {
  if (typeof message === 'string') return { text: message, fatal: true }
  if (message instanceof Error) return { text: message.message, fatal: true }
  if (message && typeof message === 'object') {
    const data = (message as { data?: unknown }).data
    if (data && typeof data === 'object') {
      const { error, fatal } = data as { error?: unknown; fatal?: unknown }
      if (typeof error === 'string' && error.trim()) {
        return { text: error, fatal: fatal === true }
      }
    }
  }
  // Unparseable / empty payload → treat as a benign notice, not a teardown.
  return { text: 'Voice agent reported an error', fatal: false }
}

interface VoiceConnectProps {
  /** Session id shared with the board SSE stream so the agent targets the right board. */
  session?: string
}

export function VoiceConnect({ session = 'default' }: VoiceConnectProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // True once the user has tapped the orb at least once. After that the orb
  // lives parked in the corner — stopping the agent does NOT bring back the
  // full-screen landing, so the board stays editable while not talking.
  const [engaged, setEngaged] = useState(false)
  const clientRef = useRef<PipecatClient | null>(null)
  // Bot (TTS) audio is NOT auto-played by the SDK — we must attach the bot's
  // incoming audio track to an <audio> element ourselves, or you hear nothing.
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const agentBase =
    process.env.NEXT_PUBLIC_VOICE_AGENT_URL?.replace(/\/$/, '') ?? 'http://localhost:7860'

  const connect = useCallback(async () => {
    setEngaged(true) // dock the orb from now on, even after a later stop
    setStatus('connecting')
    setErrorMsg(null)

    try {
      const transport = new SmallWebRTCTransport({
        // webrtcRequestParams tells the transport where to POST the WebRTC offer.
        // requestData carries the session payload; _OfferBodyCompat in bot.py
        // rewrites requestData → request_data so runner_args.body['session'] works.
        webrtcRequestParams: {
          endpoint: `${agentBase}/api/offer`,
          requestData: {
            session: {
              conversationId: session,
            },
          },
        },
      })

      const client = new PipecatClient({
        transport,
        enableMic: true,
        enableCam: false,
        callbacks: {
          onConnected: () => {
            console.log('[VoiceConnect] Transport connected')
          },
          onBotReady: () => {
            console.log('[VoiceConnect] Bot ready — live!')
            setStatus('live')
          },
          // Play the bot's TTS audio. onTrackStarted fires for every track;
          // skip the local mic track and route the remote audio into our
          // hidden <audio> element so the user actually hears the agent.
          onTrackStarted: (track, participant) => {
            if (participant?.local) return
            if (track.kind !== 'audio' || !audioRef.current) return
            audioRef.current.srcObject = new MediaStream([track])
            void audioRef.current.play().catch((e) =>
              console.warn('[VoiceConnect] audio autoplay blocked:', e),
            )
          },
          onDisconnected: () => {
            console.log('[VoiceConnect] Disconnected')
            setStatus('idle')
            clientRef.current = null
          },
          onError: (message) => {
            const { text, fatal } = parseAgentError(message)
            // console.warn (not error) so Next's dev overlay doesn't hijack the
            // screen for what may be a non-fatal agent notice.
            console.warn('[VoiceConnect] Agent error:', text, message)
            // Only a fatal error tears down the session; benign notices are
            // logged and ignored so a healthy live call keeps running.
            if (fatal) {
              setStatus('error')
              setErrorMsg(text)
            }
          },
        },
      })

      clientRef.current = client

      // initDevices requests mic permissions, then connect() posts the offer.
      await client.initDevices()
      await client.connect()
    } catch (err) {
      // warn, not error — the failure is surfaced to the user via the orb
      // tooltip; no need to also trip the Next.js dev error overlay.
      console.warn('[VoiceConnect] Connection failed:', err)
      setStatus('error')
      // A thrown connection failure is genuinely fatal, so surface its text.
      setErrorMsg(parseAgentError(err).text)
      clientRef.current = null
    }
  }, [agentBase, session])

  const disconnect = useCallback(async () => {
    try {
      await clientRef.current?.disconnect()
    } catch {
      // Ignore errors on disconnect — UI resets via onDisconnected callback.
    }
    clientRef.current = null
    setStatus('idle')
  }, [])

  // Tear down any live agent connection when this component unmounts — e.g. when
  // BoardCanvas remounts on a board switch (it's keyed by boardId). Without this,
  // the old WebRTC/bot session leaks and keeps writing to the previous board.
  useEffect(() => {
    return () => {
      void clientRef.current?.disconnect()
      clientRef.current = null
    }
  }, [])

  // ── Derived UI state ───────────────────────────────────────────────────────
  const isLive = status === 'live'
  const isConnecting = status === 'connecting'

  // The orb has three visual modes; idle and error both render the "at rest"
  // orb (error just changes the caption to "tap to retry").
  const orbState: OrbState = isLive ? 'live' : isConnecting ? 'connecting' : 'idle'

  // Clickable except mid-connect. Click connects, or disconnects when live.
  const onActivate = isLive ? disconnect : connect

  // Once engaged, the orb is parked in the corner; a small tooltip carries the
  // connecting/error feedback the landing caption used to show.
  const tooltip =
    status === 'connecting' ? 'connecting…' : status === 'error' ? errorMsg ?? 'connection failed' : null

  return (
    <>
      {/* Hidden sink for the bot's TTS audio (attached in onTrackStarted). */}
      <audio ref={audioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* Landing scrim — a semi-transparent, click-through dim over the board so
          you can still see (and edit) it. Fades away on first engage. */}
      <div className="orb-backdrop" data-hidden={engaged} aria-hidden={engaged}>
        <div className="orb-caption-wrap">
          <div className="orb-caption" data-pulse>
            tap to talk
          </div>
        </div>
      </div>

      {/* Corner status tooltip (only once docked, for connecting/error). */}
      {engaged && tooltip && (
        <div className="orb-tooltip" data-tone={status}>
          {tooltip}
        </div>
      )}

      {/* The orb — centered on the landing, parked in the corner once engaged. */}
      <Orb
        className="orb-stage"
        state={orbState}
        docked={engaged}
        listening={isLive}
        interactive={!isConnecting}
        onActivate={onActivate}
        ariaLabel={isLive ? 'Stop talking to the agent' : 'Talk to the agent'}
      />
    </>
  )
}

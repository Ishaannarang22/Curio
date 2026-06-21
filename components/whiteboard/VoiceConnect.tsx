'use client'

/**
 * VoiceConnect — floating mic button that connects the browser to the Curio
 * voice agent hosted on Pipecat Cloud (agent: curio-voice), over Daily WebRTC.
 *
 * Flow:
 *   1. User clicks "Talk" → we POST to the same-origin /api/voice/connect route.
 *   2. That route calls Pipecat Cloud's start endpoint (holding the API key
 *      server-side) and returns { dailyRoom, dailyToken } for a fresh session.
 *   3. DailyTransport joins that room; mic audio flows to the agent and the
 *      agent's TTS audio plays back in the browser.
 *   4. The agent's BoardWriter issues tool calls → POSTs to /api/board/send →
 *      SSE stream → commandQueue → tldraw board.
 *
 * No secrets are sent client-side: the Pipecat Cloud API key lives only in the
 * server route's env. Works identically on localhost and Vercel.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { PipecatClient } from '@pipecat-ai/client-js'
import { DailyTransport } from '@pipecat-ai/daily-transport'
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

  const connect = useCallback(async () => {
    setEngaged(true) // dock the orb from now on, even after a later stop
    setStatus('connecting')
    setErrorMsg(null)

    try {
      // Ask our server route to start a Pipecat Cloud session. It returns the
      // Daily room credentials ({ dailyRoom, dailyToken }) — the API key stays
      // server-side. DailyTransport consumes those field names directly.
      const res = await fetch('/api/voice/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: { conversationId: session } }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        throw new Error(detail?.error || `Could not start session (${res.status})`)
      }
      const connectParams = await res.json()

      const transport = new DailyTransport()

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

      // initDevices requests mic permissions, then connect() joins the Daily
      // room. DailyTransport maps dailyRoom -> url and dailyToken -> token.
      await client.initDevices()
      await client.connect(connectParams)
    } catch (err) {
      // warn, not error — the failure is surfaced to the user via the orb
      // tooltip; no need to also trip the Next.js dev error overlay.
      console.warn('[VoiceConnect] Connection failed:', err)
      setStatus('error')
      // A thrown connection failure is genuinely fatal, so surface its text.
      setErrorMsg(parseAgentError(err).text)
      clientRef.current = null
    }
  }, [session])

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

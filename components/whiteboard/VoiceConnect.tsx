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

import { useState, useRef, useCallback } from 'react'
import { PipecatClient } from '@pipecat-ai/client-js'
import { SmallWebRTCTransport } from '@pipecat-ai/small-webrtc-transport'

type Status = 'idle' | 'connecting' | 'live' | 'error'

/**
 * Pull a human-readable string out of whatever the Pipecat SDK or a thrown
 * value hands us. The SDK's onError callback passes an RTVIMessage
 * ({ type, data }), where data is typically { error, fatal } — String()-ing
 * that yields "[object Object]" and hides the real failure.
 */
function extractErrorText(value: unknown): string {
  if (value == null) return 'Unknown error'
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // RTVIMessage shape: { type, data: { error, fatal } }
    const data = obj.data
    if (data && typeof data === 'object') {
      const err = (data as Record<string, unknown>).error
      if (typeof err === 'string' && err) return err
    }
    if (typeof obj.error === 'string' && obj.error) return obj.error
    if (typeof obj.message === 'string' && obj.message) return obj.message
    try {
      const json = JSON.stringify(value)
      if (json && json !== '{}') return json
    } catch {
      // fall through to the generic label below
    }
  }
  return String(value)
}

interface VoiceConnectProps {
  /** Session id shared with the board SSE stream so the agent targets the right board. */
  session?: string
}

export function VoiceConnect({ session = 'default' }: VoiceConnectProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const clientRef = useRef<PipecatClient | null>(null)
  // Bot (TTS) audio is NOT auto-played by the SDK — we must attach the bot's
  // incoming audio track to an <audio> element ourselves, or you hear nothing.
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const agentBase =
    process.env.NEXT_PUBLIC_VOICE_AGENT_URL?.replace(/\/$/, '') ?? 'http://localhost:7860'

  const connect = useCallback(async () => {
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
            console.error('[VoiceConnect] Error:', message)
            setStatus('error')
            setErrorMsg(extractErrorText(message))
          },
        },
      })

      clientRef.current = client

      // initDevices requests mic permissions, then connect() posts the offer.
      await client.initDevices()
      await client.connect()
    } catch (err) {
      console.error('[VoiceConnect] Connection failed:', err)
      setStatus('error')
      setErrorMsg(extractErrorText(err))
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

  // ── Derived UI state ───────────────────────────────────────────────────────
  const isLive = status === 'live'
  const isConnecting = status === 'connecting'

  const label =
    status === 'idle'
      ? 'Talk'
      : status === 'connecting'
      ? 'Connecting…'
      : status === 'live'
      ? 'Live'
      : 'Error'

  const buttonBg =
    status === 'idle'
      ? '#6366f1'
      : status === 'connecting'
      ? '#8b5cf6'
      : status === 'live'
      ? '#10b981'
      : '#ef4444'

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      {/* Hidden sink for the bot's TTS audio (attached in onTrackStarted). */}
      <audio ref={audioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* Error tooltip */}
      {status === 'error' && errorMsg && (
        <div
          style={{
            background: '#1e293b',
            color: '#f87171',
            fontSize: 12,
            padding: '6px 10px',
            borderRadius: 8,
            maxWidth: 240,
            wordBreak: 'break-word',
            border: '1px solid #334155',
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* Main button */}
      <button
        onClick={isLive ? disconnect : connect}
        disabled={isConnecting}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 18px',
          background: buttonBg,
          color: '#fff',
          border: 'none',
          borderRadius: 999,
          fontSize: 14,
          fontWeight: 600,
          cursor: isConnecting ? 'not-allowed' : 'pointer',
          opacity: isConnecting ? 0.75 : 1,
          boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
          transition: 'background 0.2s, opacity 0.2s',
          userSelect: 'none',
        }}
        aria-label={isLive ? 'Disconnect voice agent' : 'Connect voice agent'}
      >
        {/* Mic icon / live pulse */}
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: isLive ? '#fff' : 'rgba(255,255,255,0.6)',
            boxShadow: isLive ? '0 0 0 3px rgba(255,255,255,0.35)' : 'none',
            flexShrink: 0,
          }}
        />
        {isConnecting ? 'Connecting…' : isLive ? 'Disconnect' : status === 'error' ? 'Retry' : '🎤 Talk'}
      </button>

      {/* Session badge (dev aid) */}
      {process.env.NODE_ENV === 'development' && (
        <span
          style={{
            fontSize: 10,
            color: 'rgba(255,255,255,0.5)',
            background: 'rgba(0,0,0,0.4)',
            padding: '2px 8px',
            borderRadius: 99,
          }}
        >
          session: {session}
        </span>
      )}
    </div>
  )
}

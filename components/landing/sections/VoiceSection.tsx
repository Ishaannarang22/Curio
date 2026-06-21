'use client'

import { motion, useReducedMotion } from 'framer-motion'
import Reveal from '../Reveal'
import './voice.css'

/**
 * VoiceSection — "The harness".
 *
 * One full viewport that visualizes Curio's core idea spatially: a single
 * central voice (a reactive, glowing waveform) feeding a ring of specialized
 * agents — listen, classify, structure, draw, connect.
 *
 * SIGNATURE EFFECT: the waveform's glow is *reactive*. Tall/active bars cast a
 * brighter bloom; the ambient halo behind the wave brightens and dims with the
 * overall amplitude, so the whole section reads as "one voice → many agents".
 */
export default function VoiceSection() {
  return (
    <section className="lp-section--full lp-shell voice-root" aria-labelledby="voice">
      <div className="voice-grid">
        {/* ── Copy ─────────────────────────────────────────────────────── */}
        <div className="voice-copy">
          <Reveal>
            <p className="voice-kicker">The harness</p>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 id="voice" className="voice-title">
              A harness of agents behind one voice.
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="voice-body">
              Curio isn&apos;t one chatbot. Behind the single voice, specialized
              agents listen, classify, structure, draw, and connect — each
              handling a slice of turning loose talk into a board.
            </p>
          </Reveal>
          <Reveal delay={0.15}>
            <p className="voice-body">
              Voice is the whole interface. No menus, no formatting, no wrestling
              a cursor. Just the fastest, least-resistive way to get what&apos;s
              in your head onto the canvas.
            </p>
          </Reveal>

          <Reveal delay={0.2}>
            <ul className="voice-legend" aria-hidden>
              {AGENTS.map((a) => (
                <li className="voice-legend__item" key={a.id}>
                  <span
                    className="voice-legend__dot"
                    style={{ ['--c' as string]: a.color }}
                  />
                  <span className="voice-legend__label">{a.label}</span>
                  <span className="voice-legend__desc">{a.desc}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        {/* ── Harness visual ───────────────────────────────────────────── */}
        <Reveal delay={0.12} y={28} className="voice-stagewrap">
          <HarnessStage />
        </Reveal>
      </div>
    </section>
  )
}

/* ── Agent roster ───────────────────────────────────────────────────────── */

const AGENTS = [
  { id: 'listen', label: 'Listen', desc: 'streams your raw voice', color: 'var(--lp-teal)' },
  { id: 'classify', label: 'Classify', desc: 'reads intent + topic', color: 'var(--lp-blue)' },
  { id: 'structure', label: 'Structure', desc: 'shapes maps + notes', color: 'var(--lp-purple)' },
  { id: 'draw', label: 'Draw', desc: 'renders diagrams', color: 'var(--lp-pink)' },
  { id: 'connect', label: 'Connect', desc: 'links the threads', color: 'var(--lp-amber)' },
] as const

/* ── The signature stage ────────────────────────────────────────────────── */

function HarnessStage() {
  const reduce = useReducedMotion()

  return (
    <div className="voice-stage" role="img" aria-label="One voice feeding a ring of five specialized agents">
      {/* Reactive ambient bloom — pulses with the waveform amplitude. */}
      <motion.div
        className="voice-stage__bloom"
        aria-hidden
        animate={reduce ? undefined : { opacity: [0.55, 1, 0.6, 0.95, 0.55], scale: [0.96, 1.06, 0.98, 1.04, 0.96] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Orbit ring guide. */}
      <div className="voice-stage__ring" aria-hidden />
      <div className="voice-stage__ring voice-stage__ring--inner" aria-hidden />

      {/* Connector spokes voice → agents. */}
      <Spokes reduce={!!reduce} />

      {/* The agent nodes, placed around the ring. */}
      {AGENTS.map((a, i) => (
        <AgentNode key={a.id} agent={a} index={i} total={AGENTS.length} reduce={!!reduce} />
      ))}

      {/* The central reactive waveform — the "one voice". */}
      <div className="voice-core">
        <CoreGlow reduce={!!reduce} />
        <Waveform reduce={!!reduce} />
        <span className="voice-core__label">one voice</span>
      </div>
    </div>
  )
}

/* Positions on the orbit (percentages within the square stage). */
const RADIUS = 40 // % from center
function nodePos(index: number, total: number) {
  // Start at top, go clockwise.
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2
  return {
    x: 50 + Math.cos(angle) * RADIUS,
    y: 50 + Math.sin(angle) * RADIUS,
  }
}

function AgentNode({
  agent,
  index,
  total,
  reduce,
}: {
  agent: (typeof AGENTS)[number]
  index: number
  total: number
  reduce: boolean
}) {
  const { x, y } = nodePos(index, total)
  // Each node pulses on the shared ~3.2s amplitude cycle, phase-shifted so the
  // pulse appears to ripple outward from the voice as the wave peaks.
  const delay = index * 0.18

  return (
    <motion.div
      className="voice-agent"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        ['--c' as string]: agent.color,
      }}
      animate={
        reduce
          ? undefined
          : {
              boxShadow: [
                '0 0 0 1px var(--lp-hairline), 0 0 12px -4px var(--c)',
                '0 0 0 1px var(--lp-hairline-strong), 0 0 28px -2px var(--c)',
                '0 0 0 1px var(--lp-hairline), 0 0 12px -4px var(--c)',
              ],
              scale: [1, 1.06, 1],
            }
      }
      transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut', delay }}
    >
      <span className="voice-agent__dot" />
      <span className="voice-agent__name">{agent.label}</span>
    </motion.div>
  )
}

function Spokes({ reduce }: { reduce: boolean }) {
  return (
    <svg className="voice-spokes" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="voiceSpoke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.45)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.04)" />
        </linearGradient>
      </defs>
      {AGENTS.map((a, i) => {
        const { x, y } = nodePos(i, AGENTS.length)
        return (
          <g key={a.id}>
            <line
              x1="50"
              y1="50"
              x2={x}
              y2={y}
              stroke="url(#voiceSpoke)"
              strokeWidth="0.4"
            />
            {/* Pulse travelling from voice → agent, in sync with amplitude. */}
            {!reduce && (
              <motion.circle
                r="0.9"
                fill={a.color}
                initial={{ cx: 50, cy: 50, opacity: 0 }}
                animate={{
                  cx: [50, x],
                  cy: [50, y],
                  opacity: [0, 1, 0],
                }}
                transition={{
                  duration: 1.6,
                  repeat: Infinity,
                  ease: 'easeOut',
                  delay: i * 0.22,
                  repeatDelay: 1.6,
                }}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

/* ── Reactive waveform ──────────────────────────────────────────────────── */

// Per-bar resting heights (px within an 84px field) — pleasing static silhouette.
const BAR_HEIGHTS = [26, 44, 62, 38, 78, 84, 60, 84, 78, 38, 62, 44, 26]

function Waveform({ reduce }: { reduce: boolean }) {
  return (
    <div className="voice-wave" aria-hidden>
      {BAR_HEIGHTS.map((h, i) => {
        // Bars near the center swing harder (louder), edges swing gently.
        const center = (BAR_HEIGHTS.length - 1) / 2
        const dist = Math.abs(i - center) / center // 0 at center → 1 at edge
        const swing = 0.35 + (1 - dist) * 0.5 // edge ~0.35, center ~0.85

        return (
          <motion.span
            className="voice-wave__bar"
            key={i}
            style={{ height: h }}
            animate={
              reduce
                ? undefined
                : {
                    scaleY: [1, swing, 1, swing * 1.25, 1],
                    // Reactive glow: brighter bloom when the bar is tall.
                    filter: [
                      'drop-shadow(0 0 3px rgba(45,212,191,0.45))',
                      'drop-shadow(0 0 1px rgba(45,212,191,0.25))',
                      'drop-shadow(0 0 3px rgba(45,212,191,0.45))',
                      'drop-shadow(0 0 8px rgba(59,130,246,0.75))',
                      'drop-shadow(0 0 3px rgba(45,212,191,0.45))',
                    ],
                    opacity: [0.9, 0.6, 0.9, 1, 0.9],
                  }
            }
            transition={{
              duration: 1.6,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: i * 0.07,
            }}
          />
        )
      })}
    </div>
  )
}

function CoreGlow({ reduce }: { reduce: boolean }) {
  // The halo behind the bars brightens/dims with the overall amplitude — this
  // is what makes the glow read as "reactive to the voice".
  return (
    <motion.div
      className="voice-core__glow"
      aria-hidden
      animate={
        reduce
          ? undefined
          : {
              opacity: [0.5, 0.85, 0.55, 1, 0.5],
              scale: [0.94, 1.04, 0.97, 1.08, 0.94],
            }
      }
      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
    />
  )
}

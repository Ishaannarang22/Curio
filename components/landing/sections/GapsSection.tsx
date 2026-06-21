'use client'

import { motion, useReducedMotion } from 'framer-motion'
import Reveal from '../Reveal'
import './gaps.css'

/**
 * GapsSection — "Honest by design".
 *
 * Signature light effect: light SINKS / DRAINS inward into a dark well — the
 * inverse of godrays escaping. A recessed radial pit at the section's heart
 * pulls faint streaks toward a near-black core; particles get swallowed as they
 * fall in. The "gap" chip sits over the well and carries its own inward inset
 * glow that darkens toward center (light bending into the unknown), while the
 * solid "known" chips stay lit and settled. Fills exactly one full viewport.
 */
export default function GapsSection() {
  const reduce = useReducedMotion()

  // Streaks arranged radially; each one drifts from the rim INward and dims.
  const streaks = Array.from({ length: 12 }, (_, i) => ({
    angle: (360 / 12) * i + (i % 2 ? 6 : -6),
    delay: (i * 0.42) % 4.2,
  }))

  return (
    <section className="lp-section--full lp-shell" aria-labelledby="gaps">
      <div className="gaps-grid">
        {/* ── Copy column ─────────────────────────────────────────────── */}
        <div className="gaps-copy">
          <Reveal>
            <p className="gaps-kicker">
              <span className="gaps-kicker__dot" aria-hidden />
              Honest by design
            </p>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 id="gaps" className="gaps-title">
              It surfaces the open threads —{' '}
              <span className="gaps-title__em">instead of papering over them.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="gaps-body">
              When you hit something unresolved, Curio doesn&apos;t quietly invent
              an answer. The open question stays on the board as a live thread — a
              visible &ldquo;this still needs thought&rdquo; flag.
            </p>
          </Reveal>
          <Reveal delay={0.15}>
            <p className="gaps-body">
              That keeps the ideas yours, not the model&apos;s. Your open threads
              become your next moves.
            </p>
          </Reveal>
        </div>

        {/* ── The dark well + chips ───────────────────────────────────── */}
        <Reveal delay={0.1} className="gaps-stage" y={32}>
          {/* The recessed dark well: light drains toward this core. */}
          <div className="gaps-well" aria-hidden>
            {/* The funnel rim → pit gradient; strong inset shadow recesses it. */}
            <div className="gaps-well__pit" />

            {/* Conic sheen spiralling inward, swallowed near the center. */}
            <motion.div
              className="gaps-well__spiral"
              animate={reduce ? undefined : { rotate: 360 }}
              transition={{ duration: 42, repeat: Infinity, ease: 'linear' }}
            />

            {/* Streaks of light pulled into the core — scale + fade as they fall. */}
            {!reduce && (
              <div className="gaps-well__streaks">
                {streaks.map((s, i) => (
                  <span
                    key={i}
                    className="gaps-streak"
                    style={{ transform: `rotate(${s.angle}deg)` }}
                  >
                    <motion.span
                      className="gaps-streak__line"
                      initial={{ scaleY: 1, opacity: 0 }}
                      animate={{ scaleY: 0.06, opacity: [0, 0.9, 0] }}
                      transition={{
                        duration: 4.2,
                        repeat: Infinity,
                        ease: 'easeIn',
                        delay: s.delay,
                      }}
                    />
                  </span>
                ))}
              </div>
            )}

            {/* The breathing dark core — the swallow point. */}
            <motion.div
              className="gaps-well__core"
              animate={
                reduce ? undefined : { scale: [1, 0.88, 1], opacity: [1, 0.84, 1] }
              }
              transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>

          {/* Chips: settled (lit) vs open (drawn into the well). */}
          <div className="gaps-chips">
            <Chip kind="known" text="Light reactions split water using sunlight" />
            <Chip kind="gap" text="How does ATP feed the Calvin cycle?" sink={!reduce} />
            <Chip kind="known" text="Glucose stores the captured energy" />
            <Chip kind="gap" text="Why does rubisco grab O₂ too?" sink={!reduce} />
            <Chip kind="known" text="Chlorophyll absorbs red and blue light" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}

/* ── Chip ───────────────────────────────────────────────────────────────── */

function Chip({
  kind,
  text,
  sink = false,
}: {
  kind: 'known' | 'gap'
  text: string
  sink?: boolean
}) {
  const isGap = kind === 'gap'
  return (
    <motion.div
      className={`gaps-chip gaps-chip--${kind}`}
      animate={
        sink
          ? {
              filter: ['brightness(1)', 'brightness(0.78)', 'brightness(1)'],
              scale: [1, 0.978, 1],
            }
          : undefined
      }
      transition={sink ? { duration: 4.5, repeat: Infinity, ease: 'easeInOut' } : undefined}
    >
      <span className="gaps-chip__icon" aria-hidden>
        {isGap ? (
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M9.2 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.8 2.5-2.8 2.5" />
            <path d="M12 17h.01" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        )}
      </span>
      <span className="gaps-chip__text">{text}</span>
      {isGap && <span className="gaps-chip__tag">open thread</span>}
    </motion.div>
  )
}

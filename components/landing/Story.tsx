'use client'

import { motion, useReducedMotion } from 'framer-motion'
import Reveal from './Reveal'

/**
 * Story — the scroll-told narrative, sourced from idea.md:
 *   1. The Feynman bet
 *   2. The capture→structure loop
 *   3. Voice-first companion
 *   4. Gaps stay as gaps (Feynman integrity)
 */
export default function Story() {
  return (
    <>
      {/* ── 1. The Feynman bet ─────────────────────────────────────────── */}
      <section className="lp-section lp-shell" aria-labelledby="feynman">
        <Reveal>
          <p className="lp-kicker lp-kicker--purple" style={{ textAlign: 'center', width: '100%' }}>
            The core bet
          </p>
        </Reveal>
        <Reveal delay={0.05}>
          <h2 id="feynman" className="lp-feynman">
            Your best ideas show up <em>when you&apos;re talking, not typing.</em>
          </h2>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="lp-feynman__by">
            Curio is a thinking tool, not a transcription tool. You talk; a
            harness of agents does the structuring — so you never lose the thread
            to formatting.
          </p>
        </Reveal>
      </section>

      {/* ── 2. The capture → structure loop ────────────────────────────── */}
      <section className="lp-section lp-shell" aria-labelledby="loop">
        <div className="lp-feature">
          <div className="lp-feature__copy">
            <Reveal>
              <p className="lp-kicker lp-kicker--blue">The loop</p>
            </Reveal>
            <Reveal delay={0.05}>
              <h3 id="loop" className="lp-feature__title">
                Speak loosely. Get structure back.
              </h3>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="lp-feature__body">
                You riff the way ideas actually arrive — out of order, half
                formed, branching. Curio captures the raw stream and a team of
                agents continuously restructures it into a clean board: a mind
                map here, an idea card there, a diagram when a picture helps.
              </p>
            </Reveal>
            <Reveal delay={0.15}>
              <p className="lp-feature__body">
                The board moves while you talk, and that&apos;s the point. Your
                train of thought lives in the speaking — the board is the canvas
                your ideas land on, not a tool you fight with.
              </p>
            </Reveal>
          </div>
          <Reveal delay={0.1} className="lp-figure">
            <div className="lp-figure__grid" aria-hidden />
            <LoopFigure />
          </Reveal>
        </div>
      </section>

      {/* ── 3. Voice-first companion ───────────────────────────────────── */}
      <section className="lp-section lp-shell" aria-labelledby="voice">
        <div className="lp-feature lp-feature--rev">
          <div className="lp-feature__copy">
            <Reveal>
              <p className="lp-kicker lp-kicker--teal">The harness</p>
            </Reveal>
            <Reveal delay={0.05}>
              <h3 id="voice" className="lp-feature__title">
                A harness of agents behind one voice.
              </h3>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="lp-feature__body">
                Curio isn&apos;t one chatbot. Behind the single voice,
                specialized agents listen, classify, structure, draw, and connect
                — each handling a slice of turning loose talk into a board.
              </p>
            </Reveal>
            <Reveal delay={0.15}>
              <p className="lp-feature__body">
                Voice is the whole interface. No menus, no formatting, no
                wrestling a cursor. Just the fastest, least-resistive way to get
                what&apos;s in your head onto the canvas.
              </p>
            </Reveal>
          </div>
          <Reveal delay={0.1} className="lp-figure">
            <div className="lp-figure__grid" aria-hidden />
            <VoiceFigure />
          </Reveal>
        </div>
      </section>

      {/* ── 4. Gaps stay as gaps ───────────────────────────────────────── */}
      <section className="lp-section lp-shell" aria-labelledby="gaps">
        <div className="lp-feature">
          <div className="lp-feature__copy">
            <Reveal>
              <p className="lp-kicker lp-kicker--pink">Honest by design</p>
            </Reveal>
            <Reveal delay={0.05}>
              <h3 id="gaps" className="lp-feature__title">
                It surfaces the open threads — instead of papering over them.
              </h3>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="lp-feature__body">
                When you hit something unresolved, Curio doesn&apos;t quietly
                invent an answer. The open question stays on the board as a live
                thread — a visible &ldquo;this still needs thought&rdquo; flag.
              </p>
            </Reveal>
            <Reveal delay={0.15}>
              <p className="lp-feature__body">
                That keeps the ideas yours, not the model&apos;s. Your open
                threads become your next moves.
              </p>
            </Reveal>
          </div>
          <Reveal delay={0.1} className="lp-figure">
            <div className="lp-figure__grid" aria-hidden />
            <GapFigure />
          </Reveal>
        </div>
      </section>
    </>
  )
}

/* ── Figures ──────────────────────────────────────────────────────────────*/

function LoopFigure() {
  const steps = [
    { n: '1', label: 'You speak', desc: 'Raw, unstructured thinking out loud', bg: '#3b82f6' },
    { n: '2', label: 'Agents listen', desc: 'Capture the stream, infer intent', bg: '#2dd4bf' },
    { n: '3', label: 'Board restructures', desc: 'Maps, notes, diagrams, in real time', bg: '#8b5cf6' },
  ]
  return (
    <div className="lp-loop">
      {steps.map((s) => (
        <div className="lp-loop__step" key={s.n}>
          <span className="lp-loop__num" style={{ background: s.bg }}>{s.n}</span>
          <span>
            <span className="lp-loop__label">{s.label}</span>
            <span className="lp-loop__desc" style={{ display: 'block' }}>{s.desc}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function VoiceFigure() {
  const reduce = useReducedMotion()
  // A curated waveform: heights chosen for a pleasing silhouette.
  const bars = [22, 40, 64, 38, 78, 50, 86, 44, 70, 30, 58, 36, 24]
  return (
    <div className="lp-voicefig" aria-hidden>
      {bars.map((h, i) => (
        <motion.i
          key={i}
          style={{ height: h }}
          animate={reduce ? undefined : { scaleY: [1, 0.45, 1, 0.7, 1] }}
          transition={{
            duration: 1.8,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.08,
          }}
        />
      ))}
    </div>
  )
}

function GapFigure() {
  return (
    <div className="lp-gapfig" aria-hidden>
      <div className="lp-gapchip lp-gapchip--known">
        <span className="lp-gapchip__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
        Light reactions split water using sunlight
      </div>
      <div className="lp-gapchip lp-gapchip--gap">
        <span className="lp-gapchip__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </span>
        How does ATP feed the Calvin cycle?
      </div>
      <div className="lp-gapchip lp-gapchip--known">
        <span className="lp-gapchip__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
        Glucose stores the captured energy
      </div>
    </div>
  )
}

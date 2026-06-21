'use client'

import { motion, useReducedMotion } from 'framer-motion'
import Reveal from '../Reveal'
import './feynman.css'

/**
 * FeynmanSection — "The core bet".
 *
 * The big centered thesis of the landing page: ideas arrive when you talk, not
 * when you type. A talking-vs-typing contrast (alive voice stream vs. a cold
 * blank page with a blinking cursor) dramatizes the bet, and a row of keyword
 * chips reinforces it. Designed to fill exactly one full viewport with
 * generous negative space and one strong focal headline.
 */
export default function FeynmanSection() {
  const reduce = useReducedMotion()

  const chips = [
    { label: 'No blank page', tone: 'teal' },
    { label: 'No formatting', tone: 'purple' },
    { label: 'Spoken-first', tone: 'blue' },
    { label: 'Never lose the thread', tone: 'pink' },
  ] as const

  return (
    <section className="lp-section--full lp-shell" aria-labelledby="feynman">
      <div className="fey-glow" aria-hidden />

      <div className="fey-wrap">
        <Reveal>
          <p className="fey-kicker">
            <span className="fey-kicker__dot" aria-hidden />
            The core bet
          </p>
        </Reveal>

        <Reveal delay={0.05}>
          <h2 id="feynman" className="fey-head">
            Your best ideas show up{' '}
            <em>when you&apos;re talking, not typing.</em>
          </h2>
        </Reveal>

        <Reveal delay={0.1}>
          <p className="fey-sub">
            Curio is a thinking tool, not a transcription tool. You talk; a
            harness of agents does the structuring — so you never lose the thread
            to formatting.
          </p>
        </Reveal>

        {/* Talking vs typing contrast */}
        <Reveal delay={0.15} className="fey-contrast">
          {/* Left — talking: alive, flowing */}
          <div className="fey-card fey-card--talk">
            <div className="fey-card__head">
              <span className="fey-card__pip" aria-hidden />
              Talking
            </div>
            <div className="fey-stream" aria-hidden>
              <div className="fey-stream__row">
                <Wave reduce={reduce} />
                <span className="fey-stream__text">
                  &ldquo;Okay so the core idea is really about momentum…&rdquo;
                </span>
              </div>
              <div className="fey-stream__row">
                <Wave reduce={reduce} delay={0.5} />
                <span className="fey-stream__text">
                  &ldquo;…wait, that connects back to the first point.&rdquo;
                </span>
              </div>
              <div className="fey-stream__row">
                <Wave reduce={reduce} delay={1} />
                <span className="fey-stream__text fey-stream__text--faint">
                  &ldquo;Oh — and here&apos;s the part I keep forgetting.&rdquo;
                </span>
              </div>
            </div>
          </div>

          {/* Bridge */}
          <div className="fey-bridge" aria-hidden>
            <span className="fey-bridge__lbl">vs</span>
            <svg
              className="fey-bridge__arc"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </div>

          {/* Right — typing: cold, blank, friction */}
          <div className="fey-card fey-card--type">
            <div className="fey-card__head">
              <span className="fey-card__pip" aria-hidden />
              Typing
            </div>
            <div className="fey-blank" aria-hidden>
              <span className="fey-cursor-line">
                <span className="fey-cursor" />
              </span>
              <p className="fey-blank__hint">
                A blinking cursor. A blank doc. The thought fades while you
                fight the formatting.
              </p>
            </div>
          </div>
        </Reveal>

        {/* Keyword chips */}
        <Reveal delay={0.2} className="fey-chips">
          {chips.map((c, i) => (
            <motion.span
              key={c.label}
              className={`fey-chip fey-chip--${c.tone}`}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.4, delay: 0.25 + i * 0.07, ease: 'easeOut' }}
            >
              <span className="fey-chip__dot" aria-hidden />
              {c.label}
            </motion.span>
          ))}
        </Reveal>
      </div>
    </section>
  )
}

function Wave({ reduce, delay = 0 }: { reduce: boolean | null; delay?: number }) {
  const bars = [10, 18, 22, 14, 8]
  return (
    <span className="fey-wave">
      {bars.map((h, i) => (
        <i
          key={i}
          style={{
            height: reduce ? h : undefined,
            animationDelay: reduce ? undefined : `${delay + i * 0.12}s`,
          }}
        />
      ))}
    </span>
  )
}

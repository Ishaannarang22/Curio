'use client'

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { Orb } from '@/components/whiteboard/Orb'

/**
 * Hero — the Curio name, the one-line promise, the wireframe Orb as the
 * centerpiece (reusing the real component), and the primary/secondary CTAs.
 */
export default function Hero() {
  const reduce = useReducedMotion()

  const rise = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 18 },
          animate: { opacity: 1, y: 0 },
          transition: { delay, duration: 0.6, ease: [0.16, 1, 0.3, 1] as const },
        }

  return (
    <header className="lp-hero">
      <motion.div
        className="lp-hero__orb"
        initial={reduce ? undefined : { opacity: 0, scale: 0.85 }}
        animate={reduce ? undefined : { opacity: 1, scale: 1 }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="lp-hero__orb-glow" aria-hidden />
        <div className="lp-hero__orb-mount">
          {/* Reused read-only; on the landing it's purely decorative. */}
          <Orb state="idle" interactive={false} ariaLabel="Curio orb" />
        </div>
      </motion.div>

      <motion.span className="lp-eyebrow" {...rise(0.15)}>
        <span className="lp-eyebrow__dot" aria-hidden />
        Voice-based agent harness for brainstorming
      </motion.span>

      <motion.h1 className="lp-hero__title" {...rise(0.25)}>
        Brainstorm out loud.
        <br />
        <span className="lp-grad">Watch the ideas connect.</span>
      </motion.h1>

      <motion.p className="lp-hero__sub" {...rise(0.38)}>
        Curio is a voice-based agent harness for brainstorming. Think out loud,
        the way ideas actually arrive — and a team of agents listens, structures,
        and connects your thinking into a living board of maps, notes, and
        diagrams in real time.
      </motion.p>

      <motion.div className="lp-hero__cta" {...rise(0.5)}>
        <Link href="/signup" className="lp-btn lp-btn--primary lp-btn--lg">
          Start a board
          <Arrow />
        </Link>
        <Link href="/login" className="lp-btn lp-btn--ghost lp-btn--lg">
          Log in
        </Link>
      </motion.div>

      <motion.p className="lp-hero__note" {...rise(0.6)}>
        No typing, no blank page. Just talk, and the thinking takes shape.
      </motion.p>
    </header>
  )
}

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  )
}

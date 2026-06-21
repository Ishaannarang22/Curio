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
        Voice-first study companion
      </motion.span>

      <motion.h1 className="lp-hero__title" {...rise(0.25)}>
        Talk through anything.
        <br />
        <span className="lp-grad">Watch it become a board.</span>
      </motion.h1>

      <motion.p className="lp-hero__sub" {...rise(0.38)}>
        Curio is a voice-first note-taker. Explain a topic out loud, the way you
        would to a friend — and a living whiteboard of structured notes,
        diagrams, and study artifacts builds itself in real time.
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
        No typing required. The talking is the studying.
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

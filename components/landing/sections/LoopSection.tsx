'use client'

import { motion, useReducedMotion } from 'framer-motion'
import Reveal from '../Reveal'
import './loop.css'

/**
 * LoopSection — "The loop".
 *
 * Signature visual: light EMITS / RADIATES outward from BEHIND the central
 * figure. The `.loop-light` layers (a hot bloom + two counter-rotating conic
 * godray fans + a glow ring) sit at a lower z-index than `.loop-card`, so the
 * backlight escapes around the dark-glass card's rim and projects volumetric
 * beams into the page. The light gently breathes; rays slowly rotate. All of
 * the looping motion is disabled under reduced-motion (JS gate + CSS @media).
 *
 * The figure itself is an actual cycle: three nodes on an orbit — speak →
 * agents listen → board restructures — with arrows closing the loop.
 */
export default function LoopSection() {
  const reduce = useReducedMotion()

  const nodes = [
    {
      cls: 'loop-node--1 loop-node--blue',
      tone: 'blue' as const,
      label: 'You speak',
      desc: 'Raw, unstructured thinking out loud',
    },
    {
      cls: 'loop-node--2 loop-node--teal',
      tone: 'teal' as const,
      label: 'Agents listen',
      desc: 'Capture the stream, infer intent',
    },
    {
      cls: 'loop-node--3 loop-node--purple',
      tone: 'purple' as const,
      label: 'Board restructures',
      desc: 'Maps, notes, diagrams, in real time',
    },
  ]

  return (
    <section className="lp-section--full lp-shell" aria-labelledby="loop">
      <div className="loop-wrap">
        {/* ── Copy ──────────────────────────────────────────────────────── */}
        <div className="loop-copy">
          <Reveal>
            <p className="loop-kicker">
              <span className="loop-kicker__dot" aria-hidden />
              The loop
            </p>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 id="loop" className="loop-title">
              Speak loosely. <em>Get structure back.</em>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="loop-body">
              You riff the way ideas actually arrive — out of order, half formed,
              branching. Curio captures the raw stream and a team of agents
              continuously restructures it into a clean board: a mind map here, an
              idea card there, a diagram when a picture helps.
            </p>
          </Reveal>
          <Reveal delay={0.15}>
            <p className="loop-body">
              The board moves while you talk, and that&apos;s the point. Your train
              of thought lives in the speaking — the board is the canvas your ideas
              land on, not a tool you fight with.
            </p>
          </Reveal>
        </div>

        {/* ── Figure: backlit cycle ─────────────────────────────────────── */}
        <Reveal delay={0.1} className="loop-stage">
          {/* EMITTED LIGHT — behind the card (z-index 0) */}
          <motion.div
            className="loop-light"
            aria-hidden
            initial={reduce ? false : { opacity: 0, scale: 0.9 }}
            whileInView={reduce ? undefined : { opacity: 1, scale: 1 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 1.1, ease: 'easeOut' }}
          >
            <div className="loop-light__rays" />
            <div className="loop-light__rays loop-light__rays--alt" />
            <div className="loop-light__bloom" />
            <div className="loop-light__ring" />
          </motion.div>

          {/* THE CARD — on top, backlight escapes around its rim */}
          <div className="loop-card">
            <div className="loop-orbit" aria-hidden />

            {/* cycle arrows */}
            <svg className="loop-cycle-svg" viewBox="0 0 100 100" aria-hidden>
              <defs>
                <linearGradient id="loop-arc" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.85" />
                  <stop offset="50%" stopColor="#2dd4bf" stopOpacity="0.85" />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.85" />
                </linearGradient>
                <marker
                  id="loop-arrow"
                  viewBox="0 0 10 10"
                  refX="6"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L10 5 L0 10 z" fill="#2dd4bf" />
                </marker>
              </defs>
              {/* three arcs between the orbit points, closing the loop */}
              <path
                d="M 56 22 A 34 34 0 0 1 82 64"
                stroke="url(#loop-arc)"
                markerEnd="url(#loop-arrow)"
              />
              <path
                d="M 74 72 A 34 34 0 0 1 26 72"
                stroke="url(#loop-arc)"
                markerEnd="url(#loop-arrow)"
              />
              <path
                d="M 18 64 A 34 34 0 0 1 44 22"
                stroke="url(#loop-arc)"
                markerEnd="url(#loop-arrow)"
              />
            </svg>

            {/* center hub */}
            <div className="loop-hub">
              <span className="loop-hub__mark" aria-hidden />
              <span className="loop-hub__word">Curio</span>
            </div>
          </div>

          {/* cycle nodes around the orbit (above the card) */}
          {nodes.map((n) => (
            <div className={`loop-node ${n.cls}`} key={n.label}>
              <span className="loop-node__chip">
                <span className="loop-node__dot" aria-hidden />
                {n.label}
              </span>
              <span className="loop-node__desc">{n.desc}</span>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  )
}

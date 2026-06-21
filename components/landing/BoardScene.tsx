'use client'

/**
 * BoardScene — the signature self-playing animation.
 *
 * A lightweight, bespoke echo of the real Curio board (NOT tldraw). It plays a
 * looping sequence that demonstrates the capture→structure loop: a student
 * speaks, and a mind map, sticky note, explanation card, self-drawing arrows,
 * and an image card (shimmer → resolve) assemble themselves on a dotted canvas.
 *
 * Layout uses a fixed 1000×560 design coordinate space mapped into the
 * responsive container via SVG-style percentages, so nodes + connectors always
 * line up regardless of the rendered size. Connectors animate via SVG
 * `pathLength`. The whole timeline restarts on a gentle loop.
 */

import { motion, useReducedMotion } from 'framer-motion'
import { useEffect, useState } from 'react'

/** Design space — everything is authored against this and scaled to fit. */
const W = 1000
const H = 560

type Pt = { x: number; y: number }
const pct = (p: Pt) => ({ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` })

/* Node anchor points in design space (center of each node). */
const P = {
  center: { x: 500, y: 270 },
  branchPhotosynthesis: { x: 222, y: 150 },
  branchLight: { x: 205, y: 392 },
  branchCalvin: { x: 786, y: 158 },
  note: { x: 800, y: 388 },
  explain: { x: 500, y: 470 },
  image: { x: 250, y: 270 },
}

/* Captions cycle to suggest someone brainstorming out loud. */
const CAPTIONS = [
  'Okay, so the idea is an app for finding hiking trails…',
  'It needs offline maps, and maybe a solo-safety check-in…',
  'Hmm — not sure how we\'d source the trail data.',
  'Routes could be crowd-sourced from other hikers.',
]

/* Timeline (seconds). Tuned to feel like crystallizing thought, then loop. */
const TL = {
  center: 0.3,
  bPhoto: 1.0,
  bLight: 1.5,
  bCalvin: 2.0,
  note: 2.8,
  explain: 3.4,
  image: 3.9,
  imageResolve: 5.6,
  hold: 8.4,
  loop: 9.6,
}

function springIn(delay: number) {
  return {
    initial: { opacity: 0, scale: 0.7, y: 10 },
    animate: { opacity: 1, scale: 1, y: 0 },
    transition: { delay, type: 'spring' as const, stiffness: 260, damping: 22 },
  }
}

/** A connector that draws itself, then fades with the loop. */
function Link({ from, to, color, delay, cycle }: { from: Pt; to: Pt; color: string; delay: number; cycle: number }) {
  // Slight curve so links read as hand-drawn rather than ruler-straight.
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2 - 26
  const d = `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`
  return (
    <motion.path
      key={`${cycle}`}
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeDasharray="0.5 0"
      initial={{ pathLength: 0, opacity: 0 }}
      animate={{ pathLength: 1, opacity: 0.55 }}
      transition={{ delay, duration: 0.7, ease: 'easeInOut' }}
    />
  )
}

function Pill({
  point,
  tone,
  label,
  delay,
  center,
}: {
  point: Pt
  tone: 'purple' | 'blue' | 'teal' | 'pink'
  label: string
  delay: number
  center?: boolean
}) {
  return (
    <motion.div
      className="lp-node"
      style={{ ...pct(point), transform: 'translate(-50%, -50%)' }}
      {...springIn(delay)}
    >
      <div className={`lp-pill lp-pill--${tone}${center ? ' lp-pill--center' : ''}`}>
        <span className="lp-pill__dot" />
        {label}
      </div>
    </motion.div>
  )
}

export default function BoardScene() {
  const reduce = useReducedMotion()
  const [cycle, setCycle] = useState(0)
  const [captionIdx, setCaptionIdx] = useState(0)
  const [imageResolved, setImageResolved] = useState(false)

  // Drive the loop + caption cadence + image resolve off timers.
  useEffect(() => {
    if (reduce) {
      setImageResolved(true)
      return
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    timers.push(setTimeout(() => setImageResolved(true), TL.imageResolve * 1000))
    const capTimings = [TL.center, TL.bCalvin, TL.note + 0.4, TL.image]
    capTimings.forEach((t, i) => timers.push(setTimeout(() => setCaptionIdx(i), t * 1000)))
    const loop = setTimeout(() => {
      setImageResolved(false)
      setCaptionIdx(0)
      setCycle((c) => c + 1)
    }, TL.loop * 1000)
    timers.push(loop)
    return () => timers.forEach(clearTimeout)
  }, [cycle, reduce])

  // With reduced motion: render the finished board statically (no timeline).
  const d = (t: number) => (reduce ? 0 : t)

  return (
    <div className="lp-scene" role="img" aria-label="A self-assembling Curio board: a mind map of a hiking-trail app idea, a note, an idea card, and an image card.">
      <div className="lp-scene__grid" />
      <div className="lp-scene__tag">
        <span className="lp-scene__live" />
        Listening · building board
      </div>

      <div className="lp-scene__stage" key={cycle}>
        {/* Connector layer (behind nodes). */}
        <svg className="lp-scene__links" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <Link cycle={cycle} from={P.center} to={P.branchPhotosynthesis} color="#8b5cf6" delay={d(TL.bPhoto + 0.25)} />
          <Link cycle={cycle} from={P.center} to={P.branchLight} color="#8b5cf6" delay={d(TL.bLight + 0.25)} />
          <Link cycle={cycle} from={P.center} to={P.branchCalvin} color="#8b5cf6" delay={d(TL.bCalvin + 0.25)} />
          <Link cycle={cycle} from={P.branchPhotosynthesis} to={P.image} color="#ec4899" delay={d(TL.image + 0.2)} />
        </svg>

        {/* Mind map */}
        <Pill center point={P.center} tone="purple" label="Trail app" delay={d(TL.center)} />
        <Pill point={P.branchPhotosynthesis} tone="purple" label="Offline maps" delay={d(TL.bPhoto)} />
        <Pill point={P.branchLight} tone="blue" label="Solo check-in" delay={d(TL.bLight)} />
        <Pill point={P.branchCalvin} tone="purple" label="Crowd-sourced routes" delay={d(TL.bCalvin)} />

        {/* Sticky note */}
        <motion.div className="lp-node" style={{ ...pct(P.note), transform: 'translate(-50%, -50%)' }} {...springIn(d(TL.note))}>
          <div className="lp-note">
            <div className="lp-note__eyebrow">Note</div>
            <div className="lp-note__text">Could partner with park services for trail data.</div>
          </div>
        </motion.div>

        {/* Explanation card (teal) with a flagged gap */}
        <motion.div className="lp-node" style={{ ...pct(P.explain), transform: 'translate(-50%, -50%)' }} {...springIn(d(TL.explain))}>
          <div className="lp-explain">
            <div className="lp-explain__eyebrow">
              <Spark /> In your words
            </div>
            <div className="lp-explain__line" style={{ width: '92%' }} />
            <div className="lp-explain__line" style={{ width: '78%' }} />
            <div className="lp-explain__line lp-explain__line--gap" style={{ width: '60%', marginBottom: 0 }} />
          </div>
        </motion.div>

        {/* Image card: shimmer → resolve */}
        <motion.div className="lp-node" style={{ ...pct(P.image), transform: 'translate(-50%, -50%)' }} {...springIn(d(TL.image))}>
          <div className="lp-image">
            <div className="lp-image__frame">
              {!imageResolved && <div className="lp-image__shimmer">generating…</div>}
              {imageResolved && (
                <motion.div
                  className="lp-image__pic"
                  initial={{ opacity: 0, scale: 1.05 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                />
              )}
              <div className="lp-image__chip">
                <Image /> route map mock
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Voice caption — the "thinking out loud" track. */}
      {!reduce && (
        <motion.div
          className="lp-caption"
          key={`cap-${cycle}-${captionIdx}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <span className="lp-caption__wave" aria-hidden>
            <i /><i /><i /><i />
          </span>
          {CAPTIONS[captionIdx]}
        </motion.div>
      )}
    </div>
  )
}

/* Tiny inline icons (no external deps). */
function Spark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />
    </svg>
  )
}
function Image() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.6" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  )
}

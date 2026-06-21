'use client'

import Link from 'next/link'
import Reveal from './Reveal'

/** Closing CTA band + minimal footer. */
export default function ClosingCTA() {
  return (
    <>
      <section className="lp-shell">
        <Reveal className="lp-cta">
          <h2 className="lp-cta__title">Your next study session starts with a sentence.</h2>
          <p className="lp-cta__sub">
            Open a board, start talking, and watch your understanding take shape.
          </p>
          <div className="lp-cta__actions">
            <Link href="/signup" className="lp-btn lp-btn--primary lp-btn--lg">
              Start a board
              <Arrow />
            </Link>
            <Link href="/login" className="lp-btn lp-btn--ghost lp-btn--lg">
              Log in
            </Link>
          </div>
        </Reveal>
      </section>

      <footer className="lp-footer">
        <div className="lp-footer__inner">
          <div className="lp-brand" style={{ pointerEvents: 'none' }}>
            <span className="lp-brand__mark" aria-hidden />
            Curio
          </div>
          <div className="lp-footer__copy">The talking is the studying.</div>
          <nav className="lp-footer__links" aria-label="Footer">
            <Link href="/signup">Get started</Link>
            <Link href="/login">Log in</Link>
          </nav>
        </div>
      </footer>
    </>
  )
}

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  )
}

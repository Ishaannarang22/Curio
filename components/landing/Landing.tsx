'use client'

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'

import { useEffect } from 'react'
import Link from 'next/link'
import Hero from './Hero'
import BoardScene from './BoardScene'
import FeynmanSection from './sections/FeynmanSection'
import ClosingCTA from './ClosingCTA'
import './landing.css'

/**
 * Landing — Curio's marketing front door. Client component (motion + the
 * reused Orb need the browser). Self-contained: all styles are namespaced
 * under .lp- so the app routes are untouched.
 *
 * Every child is a full-viewport section; the page uses proximity scroll-snap
 * (enabled by toggling .lp-snap-root on <html> only while mounted, so the
 * behavior never leaks into the app routes).
 */
export default function Landing() {
  useEffect(() => {
    const html = document.documentElement
    html.classList.add('lp-snap-root')
    return () => html.classList.remove('lp-snap-root')
  }, [])

  return (
    <div className="lp-root">
      <div className="lp-ambient" aria-hidden />
      <div className="lp-grain" aria-hidden />

      <nav className="lp-nav">
        <Link href="/" className="lp-brand">
          <span className="lp-brand__mark" aria-hidden />
          Curio
        </Link>
        <div className="lp-nav__links">
          <Link href="/login" className="lp-btn lp-btn--ghost lp-btn--login">
            Log in
          </Link>
          <Link href="/signup" className="lp-btn lp-btn--primary">
            Start a board
          </Link>
        </div>
      </nav>

      <main className="lp-content">
        <Hero />

        <section
          className="lp-section--full lp-scene-wrap"
          aria-label="A live demonstration of Curio building a board"
        >
          <BoardScene />
        </section>

        <FeynmanSection />

        <ClosingCTA />
      </main>
    </div>
  )
}

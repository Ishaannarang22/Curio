'use client'

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'

import Link from 'next/link'
import Hero from './Hero'
import BoardScene from './BoardScene'
import Story from './Story'
import ClosingCTA from './ClosingCTA'
import './landing.css'

/**
 * Landing — Curio's marketing front door. Client component (motion + the
 * reused Orb need the browser). Self-contained: all styles are namespaced
 * under .lp- so the app routes are untouched.
 */
export default function Landing() {
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

        <section className="lp-scene-wrap" aria-label="A live demonstration of Curio building a board">
          <BoardScene />
        </section>

        <Story />
        <ClosingCTA />
      </main>
    </div>
  )
}

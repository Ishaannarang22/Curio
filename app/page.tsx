import type { Metadata } from 'next'
import Landing from '@/components/landing/Landing'

export const metadata: Metadata = {
  title: 'Curio — Brainstorm out loud. Watch the ideas connect.',
  description:
    'Curio is a voice-based agent harness for brainstorming. Think out loud and a team of agents structures and connects your ideas into a living board of maps, notes, and diagrams in real time.',
}

export default function Home() {
  return <Landing />
}

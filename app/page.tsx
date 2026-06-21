import type { Metadata } from 'next'
import Landing from '@/components/landing/Landing'

export const metadata: Metadata = {
  title: 'Curio — Talk through anything. Watch it become a board.',
  description:
    'Curio is a voice-first study companion. Explain a topic out loud and a living whiteboard of structured notes, diagrams, and study artifacts builds itself in real time.',
}

export default function Home() {
  return <Landing />
}

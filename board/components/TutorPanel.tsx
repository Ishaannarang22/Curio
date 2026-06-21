import { useState } from 'react'

type Flashcard = {
  id: string
  question: string
  answer: string
}

const SAMPLE_CARDS: Flashcard[] = [
  { id: '1', question: 'What is photosynthesis?', answer: 'The process by which plants convert sunlight, water, and CO₂ into glucose and oxygen.' },
  { id: '2', question: 'Define mitosis.', answer: 'Cell division producing two identical daughter cells, used for growth and repair.' },
  { id: '3', question: 'What is Newton\'s second law?', answer: 'F = ma — Force equals mass times acceleration.' },
]

function FlashCard({ card }: { card: Flashcard }) {
  const [flipped, setFlipped] = useState(false)

  return (
    <div
      onClick={() => setFlipped((f) => !f)}
      style={{
        perspective: 800,
        cursor: 'pointer',
        marginBottom: 12,
        height: 90,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          transformStyle: 'preserve-3d',
          transition: 'transform 0.45s cubic-bezier(0.4,0,0.2,1)',
          transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
        }}
      >
        {/* Front */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backfaceVisibility: 'hidden',
            background: 'linear-gradient(135deg, #1e293b, #334155)',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '10px 14px',
            color: '#f1f5f9',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'Inter, system-ui, sans-serif',
            textAlign: 'center',
            lineHeight: 1.4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          }}
        >
          {card.question}
        </div>
        {/* Back */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backfaceVisibility: 'hidden',
            transform: 'rotateY(180deg)',
            background: 'linear-gradient(135deg, #0f766e, #14b8a6)',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '10px 14px',
            color: '#fff',
            fontSize: 12,
            fontFamily: 'Inter, system-ui, sans-serif',
            textAlign: 'center',
            lineHeight: 1.5,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          }}
        >
          {card.answer}
        </div>
      </div>
    </div>
  )
}

export function TutorPanel() {
  const [open, setOpen] = useState(true)

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        width: open ? 280 : 48,
        maxHeight: 'calc(100vh - 32px)',
        background: 'rgba(15, 23, 42, 0.92)',
        backdropFilter: 'blur(12px)',
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        overflow: 'hidden',
        transition: 'width 0.3s cubic-bezier(0.4,0,0.2,1)',
        zIndex: 300,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: open ? 'space-between' : 'center',
          padding: open ? '12px 14px' : '14px 0',
          borderBottom: open ? '1px solid rgba(255,255,255,0.08)' : 'none',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onClick={() => setOpen((o) => !o)}
      >
        {open && (
          <span
            style={{
              color: '#94a3b8',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontFamily: 'Inter, system-ui, sans-serif',
            }}
          >
            Tutor Panel
          </span>
        )}
        <span style={{ color: '#64748b', fontSize: 16, lineHeight: 1 }}>
          {open ? '›' : '‹'}
        </span>
      </div>

      {/* Cards */}
      {open && (
        <div
          style={{
            overflowY: 'auto',
            padding: '12px 14px',
            flex: 1,
          }}
        >
          <p
            style={{
              color: '#475569',
              fontSize: 11,
              marginBottom: 10,
              fontFamily: 'Inter, system-ui, sans-serif',
            }}
          >
            Click a card to reveal the answer
          </p>
          {SAMPLE_CARDS.map((card) => (
            <FlashCard key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  )
}

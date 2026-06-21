'use client'

import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  T,
  TLBaseShape,
} from '@tldraw/tldraw'
import { useEffect, useRef, useState } from 'react'

export type ExplanationCardShape = TLBaseShape<
  'explanation-card',
  {
    w: number
    h: number
    text: string
    revealedLength: number
    highlighted: boolean
  }
>

// Render markdown-ish text: **bold**, - bullet lists
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n')
  return lines.map((line, i) => {
    const isBullet = line.startsWith('- ') || line.startsWith('• ')
    const content = isBullet ? line.slice(2) : line
    const parts = content.split(/(\*\*[^*]+\*\*)/)
    const rendered = parts.map((p, j) =>
      p.startsWith('**') && p.endsWith('**')
        ? <strong key={j}>{p.slice(2, -2)}</strong>
        : <span key={j}>{p}</span>
    )
    if (isBullet) {
      return <li key={i} style={{ marginLeft: 16, marginBottom: 2 }}>{rendered}</li>
    }
    return line === '' ? <br key={i} /> : <p key={i} style={{ marginBottom: 4 }}>{rendered}</p>
  })
}

function TypewriterContent({ text, revealedLength }: { text: string; revealedLength: number }) {
  const [displayed, setDisplayed] = useState(() => text.slice(0, revealedLength))
  const prevRevealedRef = useRef(revealedLength)
  const prevTextRef = useRef(text)

  useEffect(() => {
    const prevRevealed = prevRevealedRef.current
    const prevText = prevTextRef.current

    // If text changed (append), animate the new portion
    if (text !== prevText && text.startsWith(prevText)) {
      const newText = text
      const startLen = prevText.length
      const endLen = text.length
      const duration = Math.min(900, Math.max(600, (endLen - startLen) * 40))
      const startTime = performance.now()

      const tick = (now: number) => {
        const elapsed = now - startTime
        const progress = Math.min(elapsed / duration, 1)
        const chars = Math.floor(startLen + (endLen - startLen) * progress)
        setDisplayed(newText.slice(0, chars))
        if (progress < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    } else if (revealedLength !== prevRevealed) {
      // revealedLength updated externally
      setDisplayed(text.slice(0, revealedLength))
    }

    prevRevealedRef.current = revealedLength
    prevTextRef.current = text
  }, [text, revealedLength])

  return <>{renderMarkdown(displayed)}</>
}

export class ExplanationCardUtil extends BaseBoxShapeUtil<ExplanationCardShape> {
  static override type = 'explanation-card' as const

  static override props: RecordProps<ExplanationCardShape> = {
    w: T.number,
    h: T.number,
    text: T.string,
    revealedLength: T.number,
    highlighted: T.boolean,
  }

  override getDefaultProps(): ExplanationCardShape['props'] {
    return { w: 280, h: 160, text: '', revealedLength: 0, highlighted: false }
  }

  override canEdit() { return false }
  override canResize() { return false }

  override component(shape: ExplanationCardShape) {
    const { text, revealedLength, highlighted } = shape.props
    return (
      <HTMLContainer
        id={shape.id}
        style={{ width: '100%', height: '100%', pointerEvents: 'all' }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: 14,
            background: 'linear-gradient(135deg, #0f766e, #14b8a6)',
            color: '#fff',
            padding: '14px 16px',
            boxShadow: highlighted
              ? '0 0 0 3px #fff, 0 0 0 6px #14b8a6, 0 4px 20px rgba(20,184,166,0.5)'
              : '0 3px 12px rgba(15,118,110,0.35)',
            transition: 'box-shadow 0.3s ease',
            overflow: 'hidden',
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: 13,
            lineHeight: 1.5,
            userSelect: 'none',
          }}
        >
          <ul style={{ listStyle: 'disc', padding: 0, margin: 0 }}>
            <TypewriterContent text={text} revealedLength={revealedLength} />
          </ul>
        </div>
      </HTMLContainer>
    )
  }

  override indicator(shape: ExplanationCardShape) {
    return <rect rx={14} width={shape.props.w} height={shape.props.h} />
  }
}
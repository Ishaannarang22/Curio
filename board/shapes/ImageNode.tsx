import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  T,
  TLBaseShape,
} from '@tldraw/tldraw'
import { useEffect, useRef, useState } from 'react'

export type ImageNodeShape = TLBaseShape<
  'image-node',
  {
    w: number
    h: number
    prompt: string
    url: string
    status: 'loading' | 'loaded'
    highlighted: boolean
  }
>

function ShimmerBox({ w, h }: { w: number; h: number }) {
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: 12,
        background: 'linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 12,
          color: '#94a3b8',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        Generating image…
      </div>
    </div>
  )
}

function CrossFadeImage({
  url,
  w,
  h,
}: {
  url: string
  w: number
  h: number
}) {
  const [opacity, setOpacity] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setOpacity(1), 50)
    return () => clearTimeout(t)
  }, [url])

  return (
    <img
      src={url}
      alt="Generated"
      style={{
        width: w,
        height: h,
        borderRadius: 12,
        objectFit: 'cover',
        opacity,
        transition: 'opacity 0.5s ease',
        display: 'block',
      }}
    />
  )
}

export class ImageNodeUtil extends BaseBoxShapeUtil<ImageNodeShape> {
  static override type = 'image-node' as const

  static override props: RecordProps<ImageNodeShape> = {
    w: T.number,
    h: T.number,
    prompt: T.string,
    url: T.string,
    status: T.literalEnum('loading', 'loaded'),
    highlighted: T.boolean,
  }

  override getDefaultProps(): ImageNodeShape['props'] {
    return { w: 280, h: 200, prompt: '', url: '', status: 'loading', highlighted: false }
  }

  override canEdit() { return false }
  override canResize() { return false }

  override component(shape: ImageNodeShape) {
    const { w, h, url, status, prompt, highlighted } = shape.props
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
            border: '2px solid #cbd5e1',
            background: '#f8fafc',
            overflow: 'hidden',
            boxShadow: highlighted
              ? '0 0 0 3px #fff, 0 0 0 6px #94a3b8, 0 4px 20px rgba(148,163,184,0.5)'
              : '0 2px 10px rgba(0,0,0,0.1)',
            transition: 'box-shadow 0.3s ease',
            position: 'relative',
          }}
        >
          {status === 'loading' ? (
            <ShimmerBox w={w} h={h} />
          ) : (
            <CrossFadeImage url={url} w={w} h={h} />
          )}
          {prompt && (
            <div
              style={{
                position: 'absolute',
                top: 8,
                left: 8,
                right: 8,
                fontSize: 10,
                color: '#64748b',
                fontFamily: 'Inter, system-ui, sans-serif',
                background: 'rgba(255,255,255,0.85)',
                borderRadius: 6,
                padding: '2px 6px',
                backdropFilter: 'blur(4px)',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {prompt}
            </div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  override indicator(shape: ImageNodeShape) {
    return <rect rx={14} width={shape.props.w} height={shape.props.h} />
  }
}

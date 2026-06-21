'use client'

import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  T,
  TLBaseShape,
} from '@tldraw/tldraw'
import { useEffect, useState } from 'react'
import { IconImage } from '../components/icons'

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

function CrossFadeImage({ url }: { url: string }) {
  const [opacity, setOpacity] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setOpacity(1), 50)
    return () => clearTimeout(t)
  }, [url])

  return (
    // Remote/generated image URLs are command-driven, so next/image cannot know
    // their origins without a server-side proxy or allowlist.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="curio-image__media"
      src={url}
      alt="Generated"
      style={{ opacity, transition: 'opacity 0.5s ease' }}
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
    const { url, status, prompt, highlighted } = shape.props
    return (
      <HTMLContainer
        id={shape.id}
        style={{ width: '100%', height: '100%', pointerEvents: 'all' }}
      >
        <div className={'curio-image' + (highlighted ? ' is-highlighted' : '')}>
          {status === 'loading' ? (
            <div className="curio-image__shimmer">Generating image…</div>
          ) : (
            <CrossFadeImage url={url} />
          )}
          {prompt && (
            <div className="curio-image__chip">
              <IconImage />
              <span>{prompt}</span>
            </div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  override indicator(shape: ImageNodeShape) {
    return <rect rx={12} width={shape.props.w} height={shape.props.h} />
  }
}

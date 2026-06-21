'use client'

import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  T,
  TLBaseShape,
  useEditor,
} from '@tldraw/tldraw'
import { useEffect, useRef } from 'react'
import { IconMindMap } from '../components/icons'
import { measureNodeHeight } from './measureNode'

export type MindMapNodeShape = TLBaseShape<
  'mind-map-node',
  {
    w: number
    h: number
    label: string
    isCenter: boolean
    highlighted: boolean
  }
>

export class MindMapNodeUtil extends BaseBoxShapeUtil<MindMapNodeShape> {
  static override type = 'mind-map-node' as const

  static override props: RecordProps<MindMapNodeShape> = {
    w: T.number,
    h: T.number,
    label: T.string,
    isCenter: T.boolean,
    highlighted: T.boolean,
  }

  override getDefaultProps(): MindMapNodeShape['props'] {
    return { w: 150, h: 46, label: '', isCenter: false, highlighted: false }
  }

  override canEdit() { return false }
  override canResize() { return false }

  override component(shape: MindMapNodeShape) {
    return <MindMapNodeView shape={shape} />
  }

  override indicator(shape: MindMapNodeShape) {
    return <rect rx={shape.props.h / 2} width={shape.props.w} height={shape.props.h} />
  }
}

// Function component so a ResizeObserver can grow the node's height to contain
// its label — otherwise long labels paint outside the fixed pill and defeat the
// overlap guard. Width stays fixed so the d3-force layout isn't disturbed (the
// layout's collide radius accounts for the grown height — see boardApi).
function MindMapNodeView({ shape }: { shape: MindMapNodeShape }) {
  const app = useEditor()
  const ref = useRef<HTMLDivElement>(null)
  const { label, isCenter, highlighted } = shape.props

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const current = app.getShape<MindMapNodeShape>(shape.id)
      if (!current) return
      const h = measureNodeHeight(el)
      if (h !== null && Math.abs(current.props.h - h) > 1) {
        app.updateShape({ id: shape.id, type: 'mind-map-node', props: { h } })
      }
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [app, shape.id])

  return (
    <HTMLContainer
      id={shape.id}
      style={{ width: '100%', height: '100%', pointerEvents: 'all' }}
    >
      <div
        ref={ref}
        className={
          'curio-node curio-node--purple curio-node--pill' +
          (isCenter ? ' curio-node--center' : '') +
          (highlighted ? ' is-highlighted' : '')
        }
      >
        <span className="curio-node__icon"><IconMindMap /></span>
        <div className="curio-node__body">
          <span className="curio-node__title">{label}</span>
        </div>
      </div>
    </HTMLContainer>
  )
}
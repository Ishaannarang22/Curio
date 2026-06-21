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
import { IconFlow } from '../components/icons'
import { measureNodeHeight } from './measureNode'

export type FlowNodeShape = TLBaseShape<
  'flow-node',
  {
    w: number
    h: number
    label: string
    subtitle: string
    highlighted: boolean
  }
>

export class FlowNodeUtil extends BaseBoxShapeUtil<FlowNodeShape> {
  static override type = 'flow-node' as const

  static override props: RecordProps<FlowNodeShape> = {
    w: T.number,
    h: T.number,
    label: T.string,
    subtitle: T.string,
    highlighted: T.boolean,
  }

  override getDefaultProps(): FlowNodeShape['props'] {
    return { w: 188, h: 72, label: '', subtitle: '', highlighted: false }
  }

  override canEdit() { return false }
  override canResize() { return false }

  override component(shape: FlowNodeShape) {
    return <FlowNodeView shape={shape} />
  }

  override indicator(shape: FlowNodeShape) {
    return <rect rx={12} width={shape.props.w} height={shape.props.h} />
  }
}

// Function component so we can use hooks: a ResizeObserver measures the real
// content height and grows the shape so the label is never painted outside the
// node's bounds (which would defeat the overlap guard). Width stays fixed so the
// flowchart's ELK layout columns aren't disturbed.
function FlowNodeView({ shape }: { shape: FlowNodeShape }) {
  const app = useEditor()
  const ref = useRef<HTMLDivElement>(null)
  const { label, subtitle, highlighted } = shape.props

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const current = app.getShape<FlowNodeShape>(shape.id)
      if (!current) return
      const h = measureNodeHeight(el)
      if (h !== null && Math.abs(current.props.h - h) > 1) {
        app.updateShape({ id: shape.id, type: 'flow-node', props: { h } })
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
          'curio-node curio-node--blue' + (highlighted ? ' is-highlighted' : '')
        }
      >
        <span className="curio-node__icon"><IconFlow /></span>
        <div className="curio-node__body">
          <span className="curio-node__title">{label}</span>
          {subtitle && <span className="curio-node__subtitle">{subtitle}</span>}
        </div>
      </div>
    </HTMLContainer>
  )
}
'use client'

import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  T,
  TLBaseShape,
} from '@tldraw/tldraw'
import { IconFlow } from '../components/icons'

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
    const { label, subtitle, highlighted } = shape.props
    return (
      <HTMLContainer
        id={shape.id}
        style={{ width: '100%', height: '100%', pointerEvents: 'all' }}
      >
        <div
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

  override indicator(shape: FlowNodeShape) {
    return <rect rx={12} width={shape.props.w} height={shape.props.h} />
  }
}
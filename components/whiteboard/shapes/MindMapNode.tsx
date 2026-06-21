'use client'

import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  T,
  TLBaseShape,
} from '@tldraw/tldraw'
import { IconMindMap } from '../components/icons'

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
    const { label, isCenter, highlighted } = shape.props
    return (
      <HTMLContainer
        id={shape.id}
        style={{ width: '100%', height: '100%', pointerEvents: 'all' }}
      >
        <div
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

  override indicator(shape: MindMapNodeShape) {
    return <rect rx={shape.props.h / 2} width={shape.props.w} height={shape.props.h} />
  }
}
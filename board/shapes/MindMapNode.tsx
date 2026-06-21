import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  T,
  TLBaseShape,
} from '@tldraw/tldraw'

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
    return { w: 140, h: 44, label: '', isCenter: false, highlighted: false }
  }

  override canEdit() { return false }
  override canResize() { return false }

  override component(shape: MindMapNodeShape) {
    const { label, isCenter, highlighted } = shape.props
    return (
      <HTMLContainer
        id={shape.id}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'all',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '999px',
            background: isCenter
              ? 'linear-gradient(135deg, #7c3aed, #a855f7)'
              : 'linear-gradient(135deg, #9333ea, #c084fc)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: isCenter ? 15 : 13,
            fontWeight: isCenter ? 700 : 500,
            fontFamily: 'Inter, system-ui, sans-serif',
            padding: '0 16px',
            boxShadow: highlighted
              ? '0 0 0 3px #fff, 0 0 0 6px #a855f7, 0 4px 20px rgba(168,85,247,0.5)'
              : isCenter
              ? '0 4px 16px rgba(124,58,237,0.4)'
              : '0 2px 8px rgba(147,51,234,0.3)',
            transition: 'box-shadow 0.3s ease',
            userSelect: 'none',
            textAlign: 'center',
            lineHeight: 1.3,
          }}
        >
          {label}
        </div>
      </HTMLContainer>
    )
  }

  override indicator(shape: MindMapNodeShape) {
    return (
      <rect
        rx={shape.props.h / 2}
        width={shape.props.w}
        height={shape.props.h}
      />
    )
  }
}

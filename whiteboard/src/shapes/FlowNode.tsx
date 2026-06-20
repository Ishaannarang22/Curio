import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  T,
  TLBaseShape,
} from '@tldraw/tldraw'

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
    return { w: 180, h: 72, label: '', subtitle: '', highlighted: false }
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
          style={{
            width: '100%',
            height: '100%',
            borderRadius: 12,
            background: 'linear-gradient(135deg, #1d4ed8, #3b82f6)',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '10px 16px',
            boxShadow: highlighted
              ? '0 0 0 3px #fff, 0 0 0 6px #3b82f6, 0 4px 20px rgba(59,130,246,0.5)'
              : '0 2px 10px rgba(29,78,216,0.35)',
            transition: 'box-shadow 0.3s ease',
            userSelect: 'none',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              fontFamily: 'Inter, system-ui, sans-serif',
              lineHeight: 1.3,
            }}
          >
            {label}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: 11,
                fontWeight: 400,
                opacity: 0.8,
                marginTop: 4,
                fontFamily: 'Inter, system-ui, sans-serif',
                lineHeight: 1.3,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  override indicator(shape: FlowNodeShape) {
    return (
      <rect rx={12} width={shape.props.w} height={shape.props.h} />
    )
  }
}

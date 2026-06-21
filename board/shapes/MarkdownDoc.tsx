import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  T,
  TLBaseShape,
  useEditor,
  useValue,
  stopEventPropagation,
} from '@tldraw/tldraw'
import { useEffect } from 'react'
import { EditorContent, useEditor as useTiptap, BubbleMenu } from '@tiptap/react'
import { editorExtensions } from '../editor/extensions'

// A whole markdown document as ONE auto-growing tldraw shape, edited in place
// with a Notion-style WYSIWYG editor (Tiptap). The canvas moves the box; a
// double-tap drops the cursor inside and live markdown formatting takes over.
// `markdown` is the canonical source of truth: the voice harness writes it, and
// the user's edits serialize back into it so the harness stays in sync.
export type MarkdownDocShape = TLBaseShape<
  'markdown-doc',
  {
    w: number
    h: number
    markdown: string
    highlighted: boolean
  }
>

const V_PAD = 24 // vertical chrome (padding) added around measured content

function MarkdownDocView({ shape }: { shape: MarkdownDocShape }) {
  // tldraw's editor (canvas). Named `app` to avoid clashing with Tiptap's.
  const app = useEditor()
  const isEditing = useValue(
    'md-doc-editing',
    () => app.getEditingShapeId() === shape.id,
    [app, shape.id],
  )

  const tiptap = useTiptap({
    extensions: editorExtensions,
    content: shape.props.markdown, // parsed as markdown by the Markdown extension
    editable: false,
    editorProps: { attributes: { class: 'curio-prose' } },
    onUpdate: ({ editor }) => {
      if (!app.getShape(shape.id)) return
      const md = editor.storage.markdown.getMarkdown()
      if (md !== shape.props.markdown) {
        app.updateShape({ id: shape.id, type: 'markdown-doc', props: { markdown: md } })
      }
    },
  })

  // Toggle editability with tldraw's edit mode; focus the editor on entry.
  useEffect(() => {
    if (!tiptap) return
    tiptap.setEditable(isEditing)
    if (isEditing) tiptap.commands.focus('end')
  }, [tiptap, isEditing])

  // Pull external markdown changes (voice harness) into the editor — but never
  // while the user is editing, so we don't clobber their cursor/content.
  useEffect(() => {
    if (!tiptap || isEditing) return
    const current = tiptap.storage.markdown.getMarkdown()
    if (current !== shape.props.markdown) {
      tiptap.commands.setContent(shape.props.markdown, false)
    }
  }, [tiptap, shape.props.markdown, isEditing])

  // Auto-grow: track the editor's real rendered height and resize the shape.
  useEffect(() => {
    if (!tiptap) return
    const dom = tiptap.view.dom as HTMLElement
    const measure = () => {
      const current = app.getShape<MarkdownDocShape>(shape.id)
      if (!current) return
      const h = Math.ceil(dom.scrollHeight) + V_PAD
      if (Math.abs(current.props.h - h) > 1) {
        app.updateShape({ id: shape.id, type: 'markdown-doc', props: { h } })
      }
    }
    const ro = new ResizeObserver(measure)
    ro.observe(dom)
    measure()
    return () => ro.disconnect()
  }, [tiptap, app, shape.id])

  const stopWhenEditing = isEditing ? stopEventPropagation : undefined

  return (
    <HTMLContainer
      id={shape.id}
      style={{
        width: '100%',
        height: '100%',
        // Only capture pointer events while editing; otherwise let the canvas
        // handle select/drag and the double-click that enters edit mode.
        pointerEvents: isEditing ? 'all' : 'none',
      }}
    >
      <div
        className={
          'curio-doc' +
          (shape.props.highlighted ? ' is-highlighted' : '') +
          (isEditing ? ' is-editing' : '')
        }
        onPointerDown={stopWhenEditing}
        onTouchStart={stopWhenEditing}
        onWheelCapture={isEditing ? (e) => e.stopPropagation() : undefined}
      >
        {tiptap && isEditing && (
          <BubbleMenu
            editor={tiptap}
            tippyOptions={{ appendTo: () => document.body }}
            className="curio-bubble"
          >
            <button
              type="button"
              className={tiptap.isActive('bold') ? 'is-active' : ''}
              onClick={() => tiptap.chain().focus().toggleBold().run()}
            >
              B
            </button>
            <button
              type="button"
              className={tiptap.isActive('italic') ? 'is-active' : ''}
              onClick={() => tiptap.chain().focus().toggleItalic().run()}
            >
              <em>i</em>
            </button>
            <button
              type="button"
              className={tiptap.isActive('strike') ? 'is-active' : ''}
              onClick={() => tiptap.chain().focus().toggleStrike().run()}
            >
              <s>S</s>
            </button>
            <button
              type="button"
              className={tiptap.isActive('code') ? 'is-active' : ''}
              onClick={() => tiptap.chain().focus().toggleCode().run()}
            >
              {'</>'}
            </button>
          </BubbleMenu>
        )}
        <EditorContent editor={tiptap} />
      </div>
    </HTMLContainer>
  )
}

export class MarkdownDocUtil extends BaseBoxShapeUtil<MarkdownDocShape> {
  static override type = 'markdown-doc' as const

  static override props: RecordProps<MarkdownDocShape> = {
    w: T.number,
    h: T.number,
    markdown: T.string,
    highlighted: T.boolean,
  }

  override getDefaultProps(): MarkdownDocShape['props'] {
    return { w: 420, h: 120, markdown: '', highlighted: false }
  }

  // Editable (Notion WYSIWYG) and width-resizable; height is driven by content.
  override canEdit() {
    return true
  }
  override canResize() {
    return true
  }

  override component(shape: MarkdownDocShape) {
    return <MarkdownDocView shape={shape} />
  }

  override indicator(shape: MarkdownDocShape) {
    return <rect rx={8} width={shape.props.w} height={shape.props.h} />
  }
}

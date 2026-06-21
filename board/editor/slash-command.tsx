// Novel-style "/" slash command menu, vendored.
// Built on @tiptap/suggestion (the same primitive @-mentions use): typing "/"
// opens a filterable popup of block types; arrow keys + Enter (or click) insert.
import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import { ReactRenderer } from '@tiptap/react'
import tippy, { type Instance } from 'tippy.js'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

type CommandItem = {
  title: string
  description: string
  searchTerms: string[]
  icon: string
  command: (props: { editor: Editor; range: Range }) => void
}

const ITEMS: CommandItem[] = [
  {
    title: 'Text',
    description: 'Plain paragraph',
    searchTerms: ['p', 'paragraph', 'text'],
    icon: '¶',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('paragraph').run(),
  },
  {
    title: 'Heading 1',
    description: 'Big section heading',
    searchTerms: ['h1', 'title', 'big'],
    icon: 'H1',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    description: 'Medium section heading',
    searchTerms: ['h2', 'subtitle'],
    icon: 'H2',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    description: 'Small section heading',
    searchTerms: ['h3', 'subheading'],
    icon: 'H3',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
  },
  {
    title: 'Bullet List',
    description: 'Unordered list',
    searchTerms: ['ul', 'unordered', 'point'],
    icon: '•',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Numbered List',
    description: 'Ordered list',
    searchTerms: ['ol', 'ordered', 'number'],
    icon: '1.',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'To-do List',
    description: 'Checkbox list',
    searchTerms: ['todo', 'task', 'check', 'box'],
    icon: '☑',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: 'Quote',
    description: 'Capture a quote',
    searchTerms: ['blockquote', 'cite'],
    icon: '❝',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Code',
    description: 'Code block',
    searchTerms: ['code', 'fence', 'pre'],
    icon: '</>',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'Divider',
    description: 'Horizontal rule',
    searchTerms: ['hr', 'divider', 'line'],
    icon: '—',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: 'Table',
    description: '3×3 table',
    searchTerms: ['table', 'grid', 'rows'],
    icon: '⊞',
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
]

function filterItems(query: string): CommandItem[] {
  const q = query.toLowerCase().trim()
  if (!q) return ITEMS
  return ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.searchTerms.some((t) => t.includes(q)),
  )
}

type MenuProps = {
  items: CommandItem[]
  command: (item: CommandItem) => void
}

export type MenuHandle = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

const CommandMenu = forwardRef<MenuHandle, MenuProps>(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => setSelected(0), [items])

  // Keep the active item scrolled into view.
  useLayoutEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-index="${selected}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        setSelected((s) => (s + items.length - 1) % items.length)
        return true
      }
      if (event.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % items.length)
        return true
      }
      if (event.key === 'Enter') {
        if (items[selected]) command(items[selected])
        return true
      }
      return false
    },
  }))

  if (items.length === 0) return null

  return (
    <div
      ref={containerRef}
      className="curio-slash-menu"
      // Don't let clicks on the popup bubble out to the canvas (tldraw would
      // exit edit mode and the insert would never happen).
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={item.title}
          type="button"
          data-index={i}
          className={'curio-slash-item' + (i === selected ? ' is-active' : '')}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
        >
          <span className="curio-slash-icon">{item.icon}</span>
          <span className="curio-slash-text">
            <span className="curio-slash-title">{item.title}</span>
            <span className="curio-slash-desc">{item.description}</span>
          </span>
        </button>
      ))}
    </div>
  )
})
CommandMenu.displayName = 'CommandMenu'

const suggestion: Omit<SuggestionOptions, 'editor'> = {
  char: '/',
  startOfLine: false,
  command: ({ editor, range, props }) => {
    ;(props as CommandItem).command({ editor, range })
  },
  items: ({ query }) => filterItems(query),
  render: () => {
    let component: ReactRenderer<MenuHandle, MenuProps>
    let popup: Instance[]

    return {
      onStart: (props) => {
        component = new ReactRenderer(CommandMenu, {
          props: {
            items: props.items as CommandItem[],
            command: (item: CommandItem) => props.command(item),
          },
          editor: props.editor,
        })
        if (!props.clientRect) return
        popup = tippy('body', {
          getReferenceClientRect: props.clientRect as () => DOMRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start',
          maxWidth: 'none',
        })
      },
      onUpdate: (props) => {
        component.updateProps({
          items: props.items as CommandItem[],
          command: (item: CommandItem) => props.command(item),
        })
        if (props.clientRect) {
          popup?.[0]?.setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect,
          })
        }
      },
      onKeyDown: (props) => {
        if (props.event.key === 'Escape') {
          popup?.[0]?.hide()
          return true
        }
        return component.ref?.onKeyDown(props) ?? false
      },
      onExit: () => {
        popup?.[0]?.destroy()
        component?.destroy()
      },
    }
  },
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...suggestion })]
  },
})

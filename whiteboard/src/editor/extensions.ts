// Vendored Notion-style editor config (the logic behind steven-tey/novel),
// built directly on Tiptap so we own every line. StarterKit supplies the core
// nodes/marks + markdown input rules (type "# ", "- ", "> ", "```"); the extras
// below add the Notion staples StarterKit omits (checkboxes, links, tables) plus
// markdown serialization so the doc round-trips to/from the voice harness.
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { Markdown } from 'tiptap-markdown'
import type { Node } from '@tiptap/pm/model'
import { SlashCommand } from './slash-command'

export const editorExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    codeBlock: { HTMLAttributes: { class: 'curio-codeblock' } },
    code: { HTMLAttributes: { class: 'curio-inline-code' } },
    horizontalRule: { HTMLAttributes: { class: 'curio-hr' } },
    dropcursor: { color: '#a3a3a3', width: 2 },
  }),
  Placeholder.configure({
    includeChildren: true,
    placeholder: ({ node }: { node: Node }) =>
      node.type.name === 'heading'
        ? `Heading ${node.attrs.level}`
        : "Type '/' for commands…",
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Link.configure({
    openOnClick: false,
    autolink: true,
    HTMLAttributes: { class: 'curio-link', rel: 'noopener noreferrer nofollow' },
  }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  // Markdown in (setContent parses md) and out (storage.markdown.getMarkdown()).
  Markdown.configure({ html: false, transformPastedText: true, linkify: true }),
  SlashCommand,
]

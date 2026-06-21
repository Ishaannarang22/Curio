import { Editor, toRichText } from '@tldraw/tldraw'

/**
 * safeShapeWrites — one choke point that makes every board write prop-safe.
 *
 * tldraw validates shape props strictly and THROWS on any prop a shape's schema
 * doesn't define. Built-in shapes diverge from our custom shapes' uniform
 * vocabulary — notably `note`, which stores text as `richText` (not `text`) and
 * has no `highlighted` prop. So generic board ops (highlightNode, updateNode,
 * addNote…) that assume the custom-shape vocabulary used to crash the command
 * queue the moment they touched a note (see the addNote/highlightNode bugs).
 *
 * `installSafeShapeWrites(editor)` wraps the editor's createShape/updateShape
 * ONCE so every write is sanitized in a single place:
 *   • unknown props are dropped (warned in dev) instead of thrown;
 *   • known aliases are mapped to each shape's real props (note.text → richText).
 * Valid props pass through untouched — this is a no-op for correct calls — so it
 * fixes the whole *class* of "prop tldraw rejects" bugs, not one prop at a time.
 */

type Props = Record<string, unknown>

/** Per-shape aliases: callers speak one vocabulary; map to the real schema. */
function applyAliases(type: string, props: Props): Props {
  if (type === 'note' && 'text' in props) {
    const { text, ...rest } = props
    return { ...rest, richText: toRichText(typeof text === 'string' ? text : String(text ?? '')) }
  }
  return props
}

/** The prop names a shape type's schema actually accepts (empty = unresolved). */
function allowedPropKeys(editor: Editor, type: string): Set<string> {
  try {
    // Every ShapeUtil declares its validators as `static props`; the keys are
    // exactly the accepted prop names (built-in shapes included).
    const util = editor.getShapeUtil(type as Parameters<Editor['getShapeUtil']>[0])
    const schema = (util?.constructor as { props?: Props } | undefined)?.props
    return new Set(schema ? Object.keys(schema) : [])
  } catch {
    return new Set()
  }
}

/** True if `type`'s schema defines `prop` (used by callers for graceful fallbacks). */
export function shapeSupportsProp(editor: Editor, type: string, prop: string): boolean {
  return allowedPropKeys(editor, type).has(prop)
}

function sanitize(editor: Editor, type: string, props: Props): Props {
  const aliased = applyAliases(type, props)
  const allowed = allowedPropKeys(editor, type)
  if (allowed.size === 0) return aliased // schema unresolved → don't strip blindly
  const out: Props = {}
  for (const [k, v] of Object.entries(aliased)) {
    if (allowed.has(k)) {
      out[k] = v
    } else if (process.env.NODE_ENV === 'development') {
      console.warn(`[boardApi] dropped prop "${k}" — not in schema for shape "${type}"`)
    }
  }
  return out
}

const INSTALLED = Symbol.for('curio.safeShapeWrites')

/** Idempotently wrap createShape/updateShape on this editor instance. */
export function installSafeShapeWrites(editor: Editor): void {
  const tagged = editor as unknown as Record<PropertyKey, unknown>
  if (tagged[INSTALLED]) return // StrictMode double-mount / re-register safe
  tagged[INSTALLED] = true

  const origCreate = editor.createShape.bind(editor)
  const origUpdate = editor.updateShape.bind(editor)

  editor.createShape = ((shape: { type: string; props?: Props } & Record<string, unknown>) =>
    origCreate(
      (shape.props
        ? { ...shape, props: sanitize(editor, shape.type, shape.props) }
        : shape) as Parameters<Editor['createShape']>[0],
    )) as Editor['createShape']

  editor.updateShape = ((shape: { type: string; props?: Props } & Record<string, unknown>) =>
    origUpdate(
      (shape.props
        ? { ...shape, props: sanitize(editor, shape.type, shape.props) }
        : shape) as Parameters<Editor['updateShape']>[0],
    )) as Editor['updateShape']
}

// measureNode — shared content-fit measurement for fixed-width node shapes.
//
// FlowNode and MindMapNode declare a fixed width but their label text wraps to
// that width and can grow TALLER than the declared box, painting outside the
// shape's bounds. The overlap guard separates shapes by their declared bounds,
// so any pixels drawn outside those bounds visually collide with neighbors no
// matter what the guard does. The fix (same principle as MarkdownDoc): measure
// the real content height and grow the shape so nothing is ever painted outside
// its bounds.
//
// We measure the inner `.curio-node__body` (the text block) rather than the
// outer flex container: the outer container centers its content, so when text
// overflows it spills symmetrically above and below and `scrollHeight` under-
// counts. The body sizes to its own content, so its `scrollHeight` is exact.
// All metrics used here (scrollHeight, computed padding/border) are LAYOUT
// pixels, unaffected by tldraw's canvas zoom transform — `getBoundingClientRect`
// would be scaled and is deliberately avoided.

const ICON_MIN_H = 18 // the node icon's fixed height; the row is at least this tall

/**
 * Compute the height the node needs to fully contain its content, given the
 * outer `.curio-node` element. Returns a rounded layout-pixel height, or null
 * if the element isn't ready to measure.
 */
export function measureNodeHeight(nodeEl: HTMLElement | null): number | null {
  if (!nodeEl) return null
  const body = nodeEl.querySelector('.curio-node__body') as HTMLElement | null
  const contentH = Math.max(body?.scrollHeight ?? 0, ICON_MIN_H)
  if (contentH <= 0) return null
  const cs = getComputedStyle(nodeEl)
  const padV = parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0')
  const bordV = parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.borderBottomWidth || '0')
  return Math.ceil(contentH + padV + bordV)
}

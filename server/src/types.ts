// The wire format the whiteboard frontend already speaks: its WebSocket client
// processes { action, payload } messages and dispatches them through
// commandQueue.ts -> boardApi.ts. Everything this server publishes is exactly
// one of these, with payload shaped for the matching commandQueue case.
export type Command = {
  action: string
  payload: Record<string, unknown>
}

export type Position = { x: number; y: number }

// What we persist per node in the board Hash. This is the SETTLED state of a
// node (e.g. an image is stored already-loaded), so a fresh client can be
// hydrated to the current board without replaying loading shimmers or pulses.
export type NodeKind = 'mindMap' | 'flow' | 'image'

export interface NodeRecord {
  id: string
  kind: NodeKind
  // common
  position?: Position
  // mind-map / flow
  label?: string
  subtitle?: string
  parentId?: string
  // image
  prompt?: string
  url?: string
  status?: 'loading' | 'loaded'
}

// An explicit connection created by connectNodes (NOT a mind-map parent edge —
// those are recreated by replaying addMindMapNode with its parentId).
export interface EdgeRecord {
  fromId: string
  toId: string
  label?: string
}

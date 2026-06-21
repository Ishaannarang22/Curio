// Lightweight inline SVG icons — no icon-library dependency. All inherit
// `currentColor`, so node icons take the family title color and toolbar icons
// take the tool color. Stroked, 24-grid, rounded caps/joins for a soft feel.
import type { SVGProps } from 'react'

function Svg(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  )
}

/* ── Node-type icons ──────────────────────────────────────────────────────── */

// Mind map — a hub branching to nodes.
export const IconMindMap = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M7.3 10.8 15.7 7M7.3 13.2 15.7 17" />
  </Svg>
)

// Flow — sequential steps.
export const IconFlow = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="3" y="4" width="8" height="6" rx="1.5" />
    <rect x="13" y="14" width="8" height="6" rx="1.5" />
    <path d="M7 10v4a2 2 0 0 0 2 2h4" />
  </Svg>
)

// Explanation — a lightbulb (an insight).
export const IconExplanation = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.3 1 2.1V16h6v-.4c0-.8.4-1.5 1-2.1A6 6 0 0 0 12 3Z" />
  </Svg>
)

// Image.
export const IconImage = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m4 17 5-5 4 4 3-3 4 4" />
  </Svg>
)

/* ── Toolbar icons ────────────────────────────────────────────────────────── */

export const IconCursor = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="m4 3 7 17 2.5-6.5L20 11 4 3Z" />
  </Svg>
)

export const IconHand = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M9 11V6.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M12 11V5.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M15 11V7.5a1.5 1.5 0 0 1 3 0v6a6 6 0 0 1-6 6h-1.5a4 4 0 0 1-2.9-1.2L4 14.5a1.6 1.6 0 0 1 2.3-2.2L9 14.5V8.5a1.5 1.5 0 0 1 3 0" />
  </Svg>
)

export const IconShape = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="11" height="11" rx="1.5" />
    <circle cx="16" cy="16" r="4.5" />
  </Svg>
)

export const IconDraw = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M16.5 4.5 19.5 7.5 8 19l-4 1 1-4 11.5-11.5Z" />
    <path d="m14.5 6.5 3 3" />
  </Svg>
)

export const IconNote = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v9l-6 6H5a1 1 0 0 1-1-1V5Z" />
    <path d="M20 14h-5a1 1 0 0 0-1 1v5" />
  </Svg>
)

export const IconArrow = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
)

export const IconUndo = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M9 7 4 12l5 5" />
    <path d="M4 12h11a5 5 0 0 1 0 10h-1" />
  </Svg>
)

export const IconRedo = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="m15 7 5 5-5 5" />
    <path d="M20 12H9a5 5 0 0 0 0 10h1" />
  </Svg>
)

export const IconZoomIn = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M10.5 8v5M8 10.5h5M20 20l-4.7-4.7" />
  </Svg>
)

export const IconZoomOut = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M8 10.5h5M20 20l-4.7-4.7" />
  </Svg>
)

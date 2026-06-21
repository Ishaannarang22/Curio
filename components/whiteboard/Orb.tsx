'use client'

/**
 * Orb — a self-contained Three.js wireframe icosahedron used as Curio's
 * voice-session control. Pure WebGL: it knows nothing about WebRTC. The parent
 * drives it via `state` and is told about clicks via `onActivate`.
 *
 * Visual language (black & white only):
 *   • thin white triangle edges on transparent bg + faint glowing vertices
 *   • idle       → slow spin + gentle "breathing" displacement (at rest)
 *   • connecting → fast spin + vertices flex outward (visibly working)
 *   • live       → steady medium spin + soft pulse (listening)
 *   • every click → an outward ripple impulse, so it "moves when you click"
 *
 * Implementation notes:
 *   • One BufferGeometry (icosahedron, detail 1) is shared by a wireframe Mesh
 *     and a Points cloud, so displacing its positions updates both at once.
 *   • Per-frame we push each vertex along its original direction by a cheap
 *     sum-of-sines noise; no noise library needed for 42 verts.
 *   • State params are lerped (not snapped) so transitions read smoothly.
 *   • The scene is built ONCE on mount; the live `state` is read through a ref
 *     so prop changes never tear down the GL context.
 */

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export type OrbState = 'idle' | 'connecting' | 'live'

/** Target animation params per state (lerped toward each frame). */
const PARAMS: Record<OrbState, { amp: number; speed: number; spin: number; opacity: number }> = {
  idle: { amp: 0.07, speed: 0.6, spin: 0.18, opacity: 0.82 },
  connecting: { amp: 0.2, speed: 2.4, spin: 1.3, opacity: 1.0 },
  live: { amp: 0.11, speed: 1.1, spin: 0.46, opacity: 0.95 },
}

/** Cheap, dependency-free pseudo-noise in [-1, 1]. */
function noise(x: number, y: number, z: number, t: number): number {
  return (
    (Math.sin(x * 1.7 + t) +
      Math.sin(y * 2.3 - t * 1.3) +
      Math.sin(z * 1.9 + t * 0.7) +
      Math.sin((x + y + z) * 1.3 + t * 1.6)) *
    0.25
  )
}

interface OrbProps {
  state: OrbState
  /** Fires on click / Enter / Space (the parent decides connect vs disconnect). */
  onActivate?: () => void
  /** When false, clicks/keys are ignored (e.g. during "connecting"). */
  interactive?: boolean
  /** Docked = parked small in the corner; otherwise centered on the landing. */
  docked?: boolean
  /** Adds a subtle halo while the agent is actively listening (live). */
  listening?: boolean
  className?: string
  ariaLabel?: string
}

export function Orb({
  state,
  onActivate,
  interactive = true,
  docked = false,
  listening = false,
  className,
  ariaLabel,
}: OrbProps) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  // Latest props read by the rAF loop without re-running the setup effect.
  const stateRef = useRef<OrbState>(state)
  const interactiveRef = useRef(interactive)
  const activateRef = useRef<(() => void) | undefined>(onActivate)
  // Click ripple energy, decays toward 0 each frame.
  const impulseRef = useRef(0)

  // Keep the rAF loop's view of the props current without re-running setup.
  useEffect(() => {
    stateRef.current = state
    interactiveRef.current = interactive
    activateRef.current = onActivate
  })

  // ── Build the scene ONCE; tear down on unmount ─────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setClearColor(0x000000, 0) // transparent — backdrop provides black
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    mount.appendChild(renderer.domElement)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.z = 3.1

    const group = new THREE.Group()
    scene.add(group)

    // Shared geometry: faceted sphere. detail 1 → 42 verts, rich but light.
    const geometry = new THREE.IcosahedronGeometry(1, 1)
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
    const original = new Float32Array(posAttr.array) // rest positions
    // Precompute unit directions so displacement is along each vertex's normal.
    const dirs = new Float32Array(original.length)
    for (let i = 0; i < original.length; i += 3) {
      const x = original[i]
      const y = original[i + 1]
      const z = original[i + 2]
      const len = Math.hypot(x, y, z) || 1
      dirs[i] = x / len
      dirs[i + 1] = y / len
      dirs[i + 2] = z / len
    }

    const edges = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        wireframe: true,
        transparent: true,
        opacity: 0.82,
      }),
    )
    group.add(edges)

    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.06,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    group.add(points)

    const edgeMat = edges.material as THREE.MeshBasicMaterial
    const pointMat = points.material as THREE.PointsMaterial

    // Current (lerped) params start at idle.
    const cur = { ...PARAMS.idle }
    let spinY = 0
    let spinX = 0

    // ── Resize: track the container box (it animates center → corner) ─────────
    const resize = () => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    const timer = new THREE.Timer()
    let raf = 0

    const tick = () => {
      raf = requestAnimationFrame(tick)
      timer.update()
      const dt = Math.min(timer.getDelta(), 0.05)
      const t = timer.getElapsed()

      // Ease current params toward the active state's targets.
      const target = PARAMS[stateRef.current]
      const k = 1 - Math.pow(0.001, dt) // frame-rate-independent smoothing
      cur.amp += (target.amp - cur.amp) * k
      cur.speed += (target.speed - cur.speed) * k
      cur.spin += (target.spin - cur.spin) * k
      cur.opacity += (target.opacity - cur.opacity) * k

      const impulse = impulseRef.current
      impulseRef.current *= Math.pow(0.0008, dt) // fast exponential decay

      // Displace each vertex outward along its rest direction.
      const amp = cur.amp + impulse * 0.45
      const speed = cur.speed
      const arr = posAttr.array as Float32Array
      for (let i = 0; i < arr.length; i += 3) {
        const nx = dirs[i]
        const ny = dirs[i + 1]
        const nz = dirs[i + 2]
        const n = noise(nx * 2.2, ny * 2.2, nz * 2.2, t * speed)
        const r = 1 + amp * n + impulse * 0.25
        arr[i] = nx * r
        arr[i + 1] = ny * r
        arr[i + 2] = nz * r
      }
      posAttr.needsUpdate = true

      // Spin (with a small click kick on top of the steady rate).
      spinY += (cur.spin + impulse * 2.0) * dt
      spinX += cur.spin * 0.35 * dt
      group.rotation.y = spinY
      group.rotation.x = Math.sin(t * 0.2) * 0.18 + spinX * 0.12

      edgeMat.opacity = cur.opacity
      pointMat.opacity = Math.min(1, cur.opacity + 0.1 + impulse * 0.4)

      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      geometry.dispose()
      edgeMat.dispose()
      pointMat.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  // ── Input → ripple + activate ──────────────────────────────────────────────
  const fire = () => {
    if (!interactiveRef.current) return
    impulseRef.current = 1
    activateRef.current?.()
  }

  return (
    <div
      ref={mountRef}
      className={className}
      data-docked={docked}
      data-listening={listening}
      role="button"
      tabIndex={interactive ? 0 : -1}
      aria-label={ariaLabel}
      aria-disabled={!interactive}
      onClick={fire}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          fire()
        }
      }}
    />
  )
}

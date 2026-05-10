/**
 * Pure function that turns a validated layout JSON into a THREE.Group.
 *
 * No I/O, no side effects on global state — caller owns disposal of
 * whatever this returns. The returned group's children are tagged with
 * userData so click-pick / drag-edit can map a hit back to the layout
 * entry it came from.
 *
 * Coordinate frame:
 *   group origin sits at the room centre, on the floor (y = 0).
 *   floor plane: y = 0
 *   ceiling:     y = dimensions.height
 *   walls span:  x ∈ [-W/2, W/2], z ∈ [-D/2, D/2]
 *
 * The shell is colour-only (palette hex per surface). Materials and
 * prop GLBs are layered in by other modules — buildGrayBox is the
 * deterministic, fast, offline-capable foundation.
 */

import * as THREE from 'three'
import { applyArchitecturalStyle } from './architecturalDetails.js'

const T = 0.04          // shell thickness (floor/wall/ceiling slabs)
const BASEBOARD_H = 0.06 // height of trim strip along back wall

/**
 * Build the scene. Returns:
 *   {
 *     group:  THREE.Group containing every visible mesh + light
 *     bounds: { min: Vector3, max: Vector3 } of the room shell
 *     shell:  the THREE.Group of named shell parts (for cutaway toggling)
 *     props:  Map<propId, THREE.Mesh> for selection / replacement
 *     lights: { fluorescent, accent }
 *   }
 */
export function buildGrayBox(layout) {
  const group = new THREE.Group()
  group.name = `gray-box:${layout.id}`

  const shell = buildShell(layout)
  group.add(shell)

  // Each prop gets a Group wrapper containing the gray-box BoxMesh.
  // GLB swaps add a child; transform handles attach to the wrapper so
  // the box (bounds reference) and the GLB transform together.
  const props = new Map()
  for (const prop of layout.props || []) {
    const wrapper = new THREE.Group()
    wrapper.name = `prop:${prop.id}`
    wrapper.userData.propId = prop.id
    wrapper.userData.propKind = prop.kind
    wrapper.userData.isPropWrapper = true
    wrapper.position.set(prop.position.x, prop.position.y, prop.position.z)
    wrapper.rotation.y = prop.rotation_y || 0
    const mesh = buildProp(prop, layout.palette)
    // Strip the position/rotation we set on the mesh — wrapper owns
    // those now. Mesh stays at local origin so the gizmo's pivot is
    // the prop's anchor point (bottom-centre).
    mesh.position.set(0, 0, 0)
    mesh.rotation.set(0, 0, 0)
    mesh.userData.isGrayBoxMesh = true
    wrapper.add(mesh)
    props.set(prop.id, wrapper)
    group.add(wrapper)
  }

  const lights = buildLights(layout)
  if (lights.fluorescent) group.add(lights.fluorescent)
  if (lights.accent) group.add(lights.accent)

  const { width, depth, height } = layout.dimensions
  const bounds = {
    min: new THREE.Vector3(-width / 2, 0, -depth / 2),
    max: new THREE.Vector3(width / 2, height, depth / 2),
  }

  return { group, bounds, shell, props, lights }
}

/**
 * Suggested camera framing for a room. Returns:
 *   { position, target, distance } — caller can apply to its own camera.
 *
 * A 3/4 angle from outside the room front, looking down slightly. The
 * distance scales with the room's diagonal so big rooms aren't clipped.
 */
export function frameCamera(layout) {
  const { width, depth, height } = layout.dimensions
  const diag = Math.hypot(width, depth)
  const distance = diag * 0.95
  const position = new THREE.Vector3(
    width * 0.55,
    height * 0.7,
    depth * 0.65 + distance * 0.5,
  )
  const target = new THREE.Vector3(0, height * 0.35, 0)
  return { position, target, distance }
}

/**
 * Per-angle cutaway: which named shell parts to hide so the camera can
 * see inside. Mirrors the previous capture util's CUTAWAY map.
 *
 * Pass an angle id and the `shell` group from buildGrayBox; the function
 * sets `.visible` on each child by name.
 */
export const CUTAWAY = {
  front: [],
  'iso-l': ['wall-left'],
  'iso-r': ['wall-right'],
  top: ['ceiling'],
}
export function applyCutaway(shell, angleId) {
  const hide = new Set(CUTAWAY[angleId] || [])
  for (const child of shell.children) {
    child.visible = !hide.has(child.name)
  }
}

// ─── shell ───────────────────────────────────────────────────────

function buildShell(layout) {
  const { width: W, depth: D, height: H } = layout.dimensions
  const p = layout.palette
  const wall = new THREE.MeshStandardMaterial({ color: p.wall, roughness: 0.95 })
  const floor = new THREE.MeshStandardMaterial({ color: p.floor, roughness: 0.9 })
  const ceiling = new THREE.MeshStandardMaterial({
    color: p.ceiling || '#e8e4d8', roughness: 0.95,
  })
  const trim = new THREE.MeshStandardMaterial({
    color: p.trim || '#6a4a32', roughness: 0.7, metalness: 0.05,
  })

  const g = new THREE.Group()
  g.name = 'shell'

  // Floor — sits *just below* y=0 so prop boxes (with origin at their
  // own bottom face) don't z-fight with the floor surface.
  const fl = new THREE.Mesh(new THREE.BoxGeometry(W, T, D), floor)
  fl.name = 'floor'
  fl.position.set(0, -T / 2, 0)
  g.add(fl)

  // Ceiling
  const ce = new THREE.Mesh(new THREE.BoxGeometry(W, T, D), ceiling)
  ce.name = 'ceiling'
  ce.position.set(0, H + T / 2, 0)
  g.add(ce)

  // Back wall
  const bw = new THREE.Mesh(new THREE.BoxGeometry(W, H, T), wall)
  bw.name = 'wall-back'
  bw.position.set(0, H / 2, -D / 2 - T / 2)
  g.add(bw)

  // Left + right walls
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(T, H, D), wall)
  leftWall.name = 'wall-left'
  leftWall.position.set(-W / 2 - T / 2, H / 2, 0)
  g.add(leftWall)

  const rightWall = leftWall.clone()
  rightWall.material = wall
  rightWall.name = 'wall-right'
  rightWall.position.x = W / 2 + T / 2
  g.add(rightWall)

  // Architectural details (baseboards on all walls, crown molding,
  // wainscoting, ceiling grid, floor pattern) — auto-driven from
  // layout.category. No-op for categories that don't add fine detail.
  applyArchitecturalStyle(g, {
    category: layout.category,
    architecture: layout.architecture,
    palette: layout.palette,
    w: W, h: H, depth: D,
    floorY: 0,
    ceilingY: H,
  })

  return g
}

// ─── props ───────────────────────────────────────────────────────

function buildProp(prop, palette) {
  // Box geometry sized to the prop's declared bounding box. Origin
  // is at the bottom-centre, so position.y = 0 sits the prop on the
  // floor without further offset.
  const { w, h, d } = prop.size
  const geo = new THREE.BoxGeometry(w, h, d)
  // Shift geometry so its bottom face is at local y=0.
  geo.translate(0, h / 2, 0)

  // Pick a colour: light tint of the wall + slight bias by kind so
  // a row of identical sizes still reads as different objects. Once
  // a real GLB swaps in this colour goes away.
  const baseHex = kindTint(prop.kind, palette)
  const mat = new THREE.MeshStandardMaterial({
    color: baseHex,
    roughness: 0.78,
    metalness: 0.04,
  })
  const m = new THREE.Mesh(geo, mat)
  m.position.set(prop.position.x, prop.position.y, prop.position.z)
  m.rotation.y = prop.rotation_y || 0
  m.userData.propId = prop.id
  m.userData.propKind = prop.kind
  m.userData.isGrayBoxProp = true
  return m
}

function kindTint(kind, palette) {
  // Slightly desaturated takes on the palette so the prop reads as
  // *belonging* to the room without exact-matching the wall.
  const base = new THREE.Color(palette.accent || '#b8a890')
  switch (kind) {
    case 'desk':
    case 'table':
    case 'cabinet':
    case 'shelf':
      return base.clone().multiplyScalar(0.85).getStyle()
    case 'chair':
      return base.clone().multiplyScalar(0.95).getStyle()
    case 'monitor':
    case 'lamp':
    case 'fixture':
      return base.clone().multiplyScalar(1.15).getStyle()
    case 'art':
    case 'sign':
      return new THREE.Color(palette.wall).clone().multiplyScalar(0.75).getStyle()
    case 'plant':
      return '#7a8c66'
    default:
      return base.getStyle()
  }
}

// ─── lighting ────────────────────────────────────────────────────

function buildLights(layout) {
  const out = {}
  const { width: W, depth: D, height: H } = layout.dimensions
  const fluo = layout.lighting?.fluorescent
  if (fluo) {
    const f = new THREE.PointLight(
      new THREE.Color(fluo.color).getHex(),
      (fluo.intensity ?? 0.55) * 1.6,
      Math.max(W, D) * 1.5,
      1.2,
    )
    f.position.set(0, H - 0.15, 0)
    f.name = 'light-fluorescent'
    out.fluorescent = f
  }
  const acc = layout.lighting?.accent
  if (acc) {
    const a = new THREE.PointLight(
      new THREE.Color(acc.color || '#ffd8a0').getHex(),
      acc.intensity ?? 0.45,
      Math.max(W, D) * 0.9,
      2.0,
    )
    // Default position: front-right, low — like a desk lamp pool. If
    // the layout specifies positions, take the first.
    const p = (acc.positions && acc.positions[0]) || { x: W * 0.2, y: 0.7, z: D * 0.15 }
    a.position.set(p.x, p.y, p.z)
    a.name = 'light-accent'
    out.accent = a
  }
  return out
}

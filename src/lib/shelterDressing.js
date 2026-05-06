import * as THREE from 'three'

/**
 * Per-category dressing for shelter rooms — 3D primitive props at
 * three depth layers (back wall, mid plane, foreground) so panning
 * the camera reveals parallax. All props are BoxGeometry with
 * MeshLambertMaterial; signage / screens / handbook pages use unlit
 * MeshBasicMaterial planes pinned to a face for emissive readout.
 *
 * Coordinates are room-local. Floor top sits at `y = -h/2 + FLOOR_T`
 * (matching the stage's floor slab); builders anchor props from
 * there upward.
 */

export const ROOM_DEPTH = 3.0
const FLOOR_T = 0.08
const BACK_Z = -ROOM_DEPTH / 2 + 0.06
const MIDBACK_Z = -ROOM_DEPTH / 2 + 0.7
const FRONT_Z = ROOM_DEPTH / 2 - 0.18

function box(w, h, d, color, x, y, z = 0) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color }),
  )
  m.position.set(x, y, z)
  return m
}

function emissive(w, h, color, x, y, z) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color }),
  )
  m.position.set(x, y, z)
  return m
}

const floorY = (h) => -h / 2 + FLOOR_T

// Hallway opening — an unlit dark panel pinned to the back wall reads
// as a void leading deeper into the shelter; surrounding frame boxes
// give it a doorway silhouette. Optional `silhouette` adds a faint
// figure-shaped prop in the corridor for "activity" depth.
function hallwayOpening(w, h, x, y, silhouette = false) {
  const g = new THREE.Group()
  // Dark void inside the doorway (unlit so it reads as deep darkness)
  g.add(emissive(w, h, 0x080a0e, x, y, BACK_Z + 0.005))
  // Frame — top + two sides
  g.add(box(w + 0.08, 0.06, 0.05, 0x2a2f36, x, y + h / 2 + 0.03, BACK_Z + 0.04))
  g.add(box(0.05, h + 0.06, 0.05, 0x2a2f36, x - w / 2 - 0.025, y, BACK_Z + 0.04))
  g.add(box(0.05, h + 0.06, 0.05, 0x2a2f36, x + w / 2 + 0.025, y, BACK_Z + 0.04))
  // Threshold strip on the floor
  g.add(box(w, 0.02, 0.04, 0x1a1f24, x, y - h / 2 + 0.01, BACK_Z + 0.04))
  if (silhouette) {
    // Distant figure standing in the corridor — slightly forward of
    // the void plane, kept dim so it reads as a silhouette.
    g.add(emissive(0.1, 0.32, 0x141820, x - 0.1, y - h / 2 + 0.16, BACK_Z + 0.012))
  }
  return g
}

// Character placeholder — anchored at (x, fy, z) so the feet sit on
// the floor at the room-local origin. Children are positioned with y
// relative to the Group (0 = feet). The Group is tagged with
// `charSpec` so the stage can swap its primitive children for a
// cloned avatar.glb once the model loads.
function character(fy, x, z = 0, opts = {}) {
  const g = new THREE.Group()
  g.position.set(x, fy, z)
  g.userData.charSpec = { opts }
  const torsoColor = opts.torsoColor ?? 0x2c3a5a
  const legColor = opts.legColor ?? 0x3a3a32
  const headColor = opts.headColor ?? 0xd6b8a8
  g.add(box(0.05, 0.2, 0.06, legColor, -0.04, 0.1, 0))
  g.add(box(0.05, 0.2, 0.06, legColor, 0.04, 0.1, 0))
  g.add(box(0.18, 0.2, 0.12, torsoColor, 0, 0.3, 0))
  g.add(box(0.04, 0.18, 0.1, torsoColor, -0.11, 0.3, 0))
  g.add(box(0.04, 0.18, 0.1, torsoColor, 0.11, 0.3, 0))
  g.add(box(0.11, 0.12, 0.11, headColor, 0, 0.46, 0))
  g.add(box(0.115, 0.04, 0.115, 0x1a1a20, 0, 0.535, 0))
  return g
}

function buildSurface(w, h) {
  const g = new THREE.Group()
  const fy = floorY(h)
  // Back wall — company plaque + emissive logo panel.
  g.add(box(1.0, 0.28, 0.05, 0xeaeaea, 0, h / 2 - 0.32, BACK_Z))
  g.add(emissive(0.7, 0.16, 0x202830, 0, h / 2 - 0.32, BACK_Z + 0.03))
  // Maintenance corridor opening at the right back — sells off-stage depth.
  g.add(hallwayOpening(0.5, 0.78, w / 2 - 0.45, fy + 0.43, true))
  // Two doors — entrance left, maintenance right.
  g.add(box(0.22, 0.7, 0.06, 0x1a1f26, -w / 2 + 0.25, fy + 0.35, MIDBACK_Z))
  g.add(box(0.22, 0.7, 0.06, 0x1a1f26, w / 2 - 0.25, fy + 0.35, MIDBACK_Z))
  // Lone figure standing on the surface near the entrance.
  g.add(character(fy, -w / 2 + 0.8, 0.2))
  // Foreground railing along the front edge.
  const railH = 0.45
  g.add(box(w * 0.85, 0.04, 0.04, 0x6a7480, 0, fy + railH, FRONT_Z))
  g.add(box(0.04, railH, 0.04, 0x6a7480, -w * 0.4, fy + railH / 2, FRONT_Z))
  g.add(box(0.04, railH, 0.04, 0x6a7480, w * 0.4, fy + railH / 2, FRONT_Z))
  return g
}

function buildLiving(w, h) {
  const g = new THREE.Group()
  const fy = floorY(h)
  // Back wall — locker cabinet with shelf line.
  g.add(box(0.45, 0.85, 0.06, 0x6b5a3a, -w / 2 + 0.4, fy + 0.43, BACK_Z))
  g.add(box(0.4, 0.03, 0.02, 0x3a2f1f, -w / 2 + 0.4, fy + 0.85, BACK_Z + 0.04))
  // Hallway leading deeper into the dorm wing.
  g.add(hallwayOpening(0.42, 0.7, w / 2 - 0.45, fy + 0.4, true))
  // Distant bunk silhouette in the corridor — dim midback prop.
  g.add(box(0.3, 0.05, 0.2, 0x483a26, w / 2 - 0.5, fy + 0.07, MIDBACK_Z))
  // Mid — bunk pairs spanning the room width, with pillows + uprights.
  const bunks = Math.max(1, Math.floor(w / 1.3))
  const spacing = w / bunks
  for (let i = 0; i < bunks; i++) {
    const x = -w / 2 + spacing * (i + 0.5)
    g.add(box(0.95, 0.1, 0.4, 0xc9b07a, x, fy + 0.13, 0.08))
    g.add(box(0.85, 0.06, 0.32, 0xe8d4a8, x - 0.2, fy + 0.18, 0.08))
    g.add(box(0.95, 0.1, 0.4, 0xc9b07a, x, fy + 0.51, 0.08))
    g.add(box(0.85, 0.06, 0.32, 0xe8d4a8, x - 0.2, fy + 0.56, 0.08))
    for (const dx of [-0.47, 0.47]) {
      for (const dz of [-0.09, 0.21]) {
        g.add(box(0.06, 0.7, 0.06, 0x6b5a3a, x + dx, fy + 0.35, dz))
      }
    }
    if (i < bunks - 1) {
      const fx = -w / 2 + spacing * (i + 1)
      g.add(box(0.4, 0.18, 0.3, 0x4a3a1f, fx, fy + 0.11, 0.1))
    }
  }
  // Resident standing in front of the locker, mid-room.
  g.add(character(fy, -w / 2 + 0.95, 0.32, { torsoColor: 0x6a4a2a }))
  return g
}

function buildOffice(w, h) {
  const g = new THREE.Group()
  const fy = floorY(h)
  // Back wall — file cabinet with drawer lines.
  g.add(box(0.5, 0.7, 0.06, 0x2a3528, -w / 2 + 0.45, fy + 0.36, BACK_Z))
  for (let i = 0; i < 3; i++) {
    g.add(box(0.42, 0.02, 0.02, 0x142014, -w / 2 + 0.45, fy + 0.16 + i * 0.2, BACK_Z + 0.04))
  }
  // Corridor opening on the right back — implies an office wing
  // continues off-screen.
  g.add(hallwayOpening(0.42, 0.78, w / 2 - 0.45, fy + 0.43, true))
  // Distant terminal in the corridor — small mid-back prop.
  g.add(box(0.16, 0.18, 0.08, 0x1a261a, w / 2 - 0.5, fy + 0.13, MIDBACK_Z))
  g.add(emissive(0.12, 0.1, 0x4a8a6a, w / 2 - 0.5, fy + 0.16, MIDBACK_Z + 0.05))
  // Mid — terminal stations: desk, legs, monitor, keyboard, tower, chair.
  const stationW = 1.05
  const stations = Math.max(1, Math.floor((w - 0.9) / stationW))
  const startX = -w / 2 + 0.95
  const spacing = stations > 1 ? (w - 1.5) / (stations - 1) : 0
  for (let i = 0; i < stations; i++) {
    const x = stations === 1 ? 0.2 : startX + spacing * i
    // Desk + legs
    g.add(box(0.7, 0.06, 0.4, 0x2d3a2d, x, fy + 0.22, 0.0))
    for (const dx of [-0.32, 0.32]) {
      for (const dz of [-0.16, 0.16]) {
        g.add(box(0.04, 0.18, 0.04, 0x1d2a1d, x + dx, fy + 0.1, dz))
      }
    }
    // Monitor + glowing screen on the desk's back edge
    g.add(box(0.42, 0.32, 0.18, 0x14201a, x, fy + 0.43, -0.06))
    g.add(emissive(0.34, 0.24, 0x9be3c8, x, fy + 0.43, 0.034))
    // Keyboard
    g.add(box(0.32, 0.02, 0.1, 0x1c2620, x, fy + 0.26, 0.12))
    // Tower beside the desk
    g.add(box(0.1, 0.3, 0.2, 0x1d2a1d, x + 0.42, fy + 0.18, 0.04))
    // Chair pulled out
    g.add(box(0.32, 0.05, 0.32, 0x2a3a2a, x, fy + 0.22, 0.34))
    g.add(box(0.32, 0.3, 0.05, 0x2a3a2a, x, fy + 0.4, 0.48))
    for (const dx of [-0.13, 0.13]) {
      for (const dz of [0.21, 0.47]) {
        g.add(box(0.04, 0.22, 0.04, 0x1a2a1a, x + dx, fy + 0.11, dz))
      }
    }
    // Worker standing at the chair, mid-room — every other station.
    if (i % 2 === 0) {
      g.add(character(fy, x, 0.34, { torsoColor: 0x2c3a5a }))
    }
  }
  return g
}

function buildBreakRoom(w, h) {
  const g = new THREE.Group()
  const fy = floorY(h)
  // Back wall — framed handbook page + clock.
  g.add(box(0.4, 0.5, 0.04, 0xb88866, -w / 2 + 0.4, fy + 0.55, BACK_Z))
  g.add(emissive(0.34, 0.42, 0xf5e6c8, -w / 2 + 0.4, fy + 0.55, BACK_Z + 0.025))
  g.add(box(0.18, 0.18, 0.04, 0xeaeaea, w / 2 - 0.3, fy + 0.7, BACK_Z))
  g.add(emissive(0.14, 0.14, 0x303a44, w / 2 - 0.3, fy + 0.7, BACK_Z + 0.025))
  // Small alcove on the right back — implies a connecting hallway.
  g.add(hallwayOpening(0.28, 0.5, w / 2 - 0.3, fy + 0.28))
  // Mid — two chairs facing each other across a side table with lamp.
  for (const cfg of [
    { cx: -0.05, backZ: -0.06 },
    { cx: 0.45, backZ: 0.16 },
  ]) {
    g.add(box(0.32, 0.06, 0.32, 0x4a2222, cfg.cx, fy + 0.22, 0.05))
    g.add(box(0.32, 0.32, 0.05, 0x4a2222, cfg.cx, fy + 0.42, cfg.backZ))
    for (const dx of [-0.13, 0.13]) {
      for (const dz of [-0.08, 0.18]) {
        g.add(box(0.04, 0.22, 0.04, 0x2a1010, cfg.cx + dx, fy + 0.11, dz))
      }
    }
  }
  // Side table + lamp
  g.add(box(0.22, 0.06, 0.22, 0x6a4022, 0.2, fy + 0.3, 0.05))
  g.add(box(0.04, 0.22, 0.04, 0x4a2812, 0.2, fy + 0.18, 0.05))
  g.add(box(0.12, 0.16, 0.12, 0xf5d8a8, 0.2, fy + 0.42, 0.05))
  // Lone figure standing far left — mid plane, looking inward.
  g.add(character(fy, -w / 2 + 0.7, 0.15, { torsoColor: 0x4a2222 }))
  return g
}

function buildWellness(w, h) {
  const g = new THREE.Group()
  const fy = floorY(h)
  // Back wall — framed art + hanging towel rack.
  g.add(box(0.5, 0.4, 0.04, 0x5a4080, -w / 2 + 0.45, fy + 0.55, BACK_Z))
  g.add(emissive(0.42, 0.32, 0xa080d0, -w / 2 + 0.45, fy + 0.55, BACK_Z + 0.025))
  g.add(box(0.4, 0.04, 0.03, 0xeaeaea, w / 4, fy + 0.85, BACK_Z + 0.04))
  for (const dx of [-0.12, 0.12]) {
    g.add(box(0.1, 0.2, 0.02, 0xd8c8e8, w / 4 + dx, fy + 0.74, BACK_Z + 0.06))
  }
  // Meditation alcove on the right back.
  g.add(hallwayOpening(0.32, 0.55, w / 2 - 0.55, fy + 0.32))
  // Mid — cushion row + speaker.
  const cushions = Math.max(2, Math.floor((w - 0.6) / 0.7))
  const spacing = (w - 1.2) / Math.max(cushions - 1, 1)
  for (let i = 0; i < cushions; i++) {
    const x = -w / 2 + 0.6 + spacing * i
    g.add(box(0.55, 0.16, 0.35, 0xc9a8e0, x, fy + 0.1, 0.05))
  }
  g.add(box(0.18, 0.28, 0.18, 0x2a1f3a, w / 2 - 0.3, fy + 0.16, -0.18))
  // Visitor on a cushion (standing nearby, mid plane).
  g.add(character(fy, -w / 2 + 0.4, 0.25, { torsoColor: 0x6a4a8a }))
  // Foreground potted plant.
  g.add(box(0.22, 0.12, 0.22, 0x6b4a2a, w / 2 - 0.3, fy + 0.06, FRONT_Z - 0.05))
  g.add(box(0.16, 0.5, 0.16, 0x4a8a4a, w / 2 - 0.3, fy + 0.37, FRONT_Z - 0.05))
  return g
}

const BUILDERS = {
  surface: buildSurface,
  living: buildLiving,
  office: buildOffice,
  'break-room': buildBreakRoom,
  wellness: buildWellness,
}

export function buildDressing(category, w, h) {
  const fn = BUILDERS[category]
  if (!fn) return new THREE.Group()
  return fn(w, h)
}

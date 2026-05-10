import * as THREE from 'three'

/**
 * Adds architectural geometry (trim, ceiling grid, floor pattern) to
 * an existing room shell so every room reads as a *built* space
 * before any props are added. Shared by:
 *   - src/lib/grayBoxBuilder.js (rooms editor, shelter-room preview)
 *   - src/views/ShelterStage3D.jsx (shelter dollhouse cells)
 *
 * Auto-driven from `layout.category`. No new schema fields, no UI —
 * pick the preset, emit geometry. Per-room overrides can come later.
 *
 * The two shells use different coordinate systems (gray-box has
 * floor at y=0; shelter has floor at y=-h/2), so helpers take
 * explicit `floorY` / `ceilingY` instead of relying on a convention.
 */

// Category presets — picked so the three tutorial-bundled rooms read
// distinctly with zero props:
//   lobby   → warm bureaucratic / wainscoted reception
//   work    → cold institutional / fluorescent ceiling tiles
//   service → mid-warm break-room
//   mystery → spare, low-light vault
const CATEGORY_PRESETS = {
  lobby: {
    trim: 'wainscot-half',
    ceiling: 'coffered',
    floor: 'parquet',
    lighting: { fluorescentMul: 0.7, accentMul: 1.1, tone: 'warm' },
  },
  work: {
    trim: 'baseboard',
    ceiling: 'drop-tile',
    floor: 'linoleum-strip',
    lighting: { fluorescentMul: 1.15, accentMul: 0.55, tone: 'cold' },
  },
  service: {
    trim: 'wainscot-quarter',
    ceiling: 'plain',
    floor: 'subway-tile',
    lighting: { fluorescentMul: 0.65, accentMul: 1.0, tone: 'warm' },
  },
  mystery: {
    trim: 'baseboard',
    ceiling: 'plain',
    floor: 'plain',
    lighting: { fluorescentMul: 0.35, accentMul: 1.4, tone: 'cold' },
  },
}

/** Style option lists for the UI dropdowns. */
export const TRIM_STYLES = ['baseboard', 'wainscot-quarter', 'wainscot-half']
export const CEILING_STYLES = ['plain', 'drop-tile', 'coffered']
export const FLOOR_STYLES = [
  'plain', 'checker', 'diamond', 'linoleum-strip', 'parquet',
  'plank', 'subway-tile', 'carpet-tile', 'terrazzo', 'herringbone',
]

export function presetForCategory(category) {
  return CATEGORY_PRESETS[category] || CATEGORY_PRESETS.work
}

/**
 * Top-level entry — applies the preset matching `category` to the
 * room shell. Caller passes the shell group + its bounds; helpers
 * append meshes as children. Safe to call once per shell.
 *
 * @param {THREE.Group} group - the room shell group
 * @param {Object} opts
 * @param {string} opts.category - layout.category (lobby/work/...)
 * @param {Object} opts.palette - { wall, floor, accent, ceiling, trim }
 * @param {number} opts.w  - room width  (x extent in metres)
 * @param {number} opts.h  - room height (y extent in metres)
 * @param {number} opts.depth - room depth (z extent in metres)
 * @param {number} opts.floorY    - world-y of the floor surface
 * @param {number} opts.ceilingY  - world-y of the ceiling surface
 * @param {number} [opts.minDetailScale=0.4] - shells smaller than this
 *   (in metres on the dominant axis) skip the finer details.
 */
export function applyArchitecturalStyle(group, opts) {
  const preset = presetForCategory(opts.category)
  const arch = opts.architecture || {}
  // Per-room overrides win over the category preset when present.
  const trimStyle = arch.trim || preset.trim
  const ceilingStyle = arch.ceiling || preset.ceiling
  const floorStyle = arch.floor || preset.floor
  const dominant = Math.min(opts.w, opts.h, opts.depth)
  const skipFine = dominant < (opts.minDetailScale ?? 0.4)
  addTrim(group, { ...opts, style: trimStyle, skipFine })
  if (!opts.skipCeiling) {
    addCeilingGrid(group, { ...opts, style: ceilingStyle, skipFine })
  }
  addFloorPattern(group, { ...opts, style: floorStyle })
  // Stash a rebuild closure so later layouts fetched from the bridge
  // (which may carry per-room architecture overrides) can re-run the
  // pass with the override applied. Captures the original opts so
  // callers don't have to remember dimensions / palette / etc.
  group.userData.rebuildArchitecture = (override) => {
    clearArchitecturalDetails(group)
    applyArchitecturalStyle(group, {
      ...opts,
      architecture: { ...arch, ...(override?.architecture || {}) },
      palette: override?.palette || opts.palette,
    })
  }
}

/** Strip every architectural-detail mesh + the architectural-floor mesh
 *  from a shell group so the next applyArchitecturalStyle starts clean. */
export function clearArchitecturalDetails(group) {
  const doomed = []
  group.traverse((o) => {
    if (o.userData?.isArchitecturalDetail) doomed.push(o)
  })
  // The architectural floor mesh is tracked separately because it's
  // a Plane with a CanvasTexture (not just a Box geometry detail).
  const floor = group.userData?.architecturalFloor?.mesh
  if (floor) doomed.push(floor)
  for (const m of doomed) {
    m.parent?.remove(m)
    m.geometry?.dispose?.()
    if (m.material) {
      m.material.map?.dispose?.()
      m.material.dispose?.()
    }
  }
  delete group.userData.architecturalFloor
}

// ── Trim ────────────────────────────────────────────────────────────

function trimMaterial(palette) {
  return new THREE.MeshStandardMaterial({
    color: palette?.trim || '#6a4a32',
    roughness: 0.7,
    metalness: 0.05,
  })
}

function wainscotMaterial(palette) {
  // Slightly tinted version of the trim colour — reads as paneling
  // distinct from both wall and trim cap.
  const base = new THREE.Color(palette?.trim || '#6a4a32').clone()
  base.lerp(new THREE.Color(palette?.wall || '#cccccc'), 0.4)
  return new THREE.MeshStandardMaterial({
    color: base, roughness: 0.85, metalness: 0.02,
  })
}

export function addTrim(group, opts) {
  const { w, h, depth, floorY, ceilingY, palette, style, skipFine, wallT = 0 } = opts
  const trim = trimMaterial(palette)
  // Visible interior surfaces — the side of the wall that faces the
  // camera. In shelter cells the wall thickness lives inside the room
  // volume, so we offset by wallT; in gray-box builds wallT is 0
  // because walls sit outside the volume.
  const innerBackZ = -depth / 2 + wallT
  const innerLeftX = -w / 2 + wallT
  const innerRightX = w / 2 - wallT
  const innerDepth = depth - wallT * 2
  // Baseboard — 6 cm strip along back, left, right walls at floor.
  // The baseboard's centre is wallT + BBT/2 from the geometric edge so
  // it sits PROUD of the visible wall surface instead of intersecting.
  const BB = 0.06
  const BBT = 0.025
  group.add(makeBox(w - wallT * 2, BB, BBT, 0, floorY + BB / 2, innerBackZ + BBT / 2, trim))
  group.add(makeBox(BBT, BB, innerDepth, innerLeftX + BBT / 2, floorY + BB / 2, 0, trim))
  group.add(makeBox(BBT, BB, innerDepth, innerRightX - BBT / 2, floorY + BB / 2, 0, trim))

  if (!skipFine) {
    // Crown molding — thin strip at the wall-ceiling junction.
    const CM = 0.04
    const CMT = 0.025
    group.add(makeBox(w - wallT * 2, CM, CMT, 0, ceilingY - CM / 2, innerBackZ + CMT / 2, trim))
    group.add(makeBox(CMT, CM, innerDepth, innerLeftX + CMT / 2, ceilingY - CM / 2, 0, trim))
    group.add(makeBox(CMT, CM, innerDepth, innerRightX - CMT / 2, ceilingY - CM / 2, 0, trim))
  }

  if (style === 'wainscot-half' || style === 'wainscot-quarter') {
    const wHeight = style === 'wainscot-half' ? h * 0.45 : h * 0.25
    const panel = wainscotMaterial(palette)
    const cap = trim
    const PT = 0.018  // panel thickness — proud of the wall by this much
    const CT = 0.03   // cap (chair-rail) thickness
    // Back wall band
    const backZ = innerBackZ + PT / 2
    group.add(makeBox(w - wallT * 2 - BBT * 2, wHeight, PT, 0, floorY + BB + wHeight / 2, backZ, panel))
    group.add(makeBox(w - wallT * 2 - BBT * 2, CT, PT * 1.4, 0, floorY + BB + wHeight + CT / 2, backZ, cap))
    // Left + right walls
    const sideX = innerLeftX + PT / 2
    group.add(makeBox(PT, wHeight, innerDepth - BBT * 2, sideX, floorY + BB + wHeight / 2, 0, panel))
    group.add(makeBox(PT, CT, innerDepth - BBT * 2, sideX, floorY + BB + wHeight + CT / 2, 0, cap))
    const sideX2 = innerRightX - PT / 2
    group.add(makeBox(PT, wHeight, innerDepth - BBT * 2, sideX2, floorY + BB + wHeight / 2, 0, panel))
    group.add(makeBox(PT, CT, innerDepth - BBT * 2, sideX2, floorY + BB + wHeight + CT / 2, 0, cap))
  }
}

// ── Ceiling grid ────────────────────────────────────────────────────

export function addCeilingGrid(group, opts) {
  const { w, depth, ceilingY, palette, style, skipFine } = opts
  if (style === 'plain' || skipFine) return
  // Just-below-ceiling plane carrying a CanvasTexture of the grid
  // pattern. Cheap (one mesh + one texture) and reads at any scale.
  const tex = ceilingGridTexture(style, palette)
  const geo = new THREE.PlaneGeometry(w * 0.99, depth * 0.99)
  const mat = new THREE.MeshStandardMaterial({
    map: tex, transparent: true, opacity: 0.9, roughness: 0.95,
  })
  const m = new THREE.Mesh(geo, mat)
  m.rotation.x = Math.PI / 2  // face down
  m.position.set(0, ceilingY - 0.01, 0)
  group.add(m)
}

function ceilingGridTexture(style, palette) {
  const SIZE = 512
  const c = document.createElement('canvas')
  c.width = c.height = SIZE
  const ctx = c.getContext('2d')
  const tileHex = palette?.ceiling || '#e8e4d8'
  const groutHex = mix(palette?.trim || '#6a4a32', '#000000', 0.3)
  ctx.fillStyle = tileHex
  ctx.fillRect(0, 0, SIZE, SIZE)
  ctx.strokeStyle = groutHex
  ctx.lineWidth = style === 'coffered' ? 6 : 2
  const divisions = style === 'coffered' ? 4 : 6
  const step = SIZE / divisions
  ctx.beginPath()
  for (let i = 1; i < divisions; i += 1) {
    ctx.moveTo(i * step, 0); ctx.lineTo(i * step, SIZE)
    ctx.moveTo(0, i * step); ctx.lineTo(SIZE, i * step)
  }
  ctx.stroke()
  if (style === 'coffered') {
    // Inner shadow rectangle per tile so it reads as recessed.
    ctx.strokeStyle = mix(palette?.wall || '#cccccc', '#000000', 0.1)
    ctx.lineWidth = 1
    for (let i = 0; i < divisions; i += 1) {
      for (let j = 0; j < divisions; j += 1) {
        const x = i * step + 8, y = j * step + 8
        ctx.strokeRect(x, y, step - 16, step - 16)
      }
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// ── Floor pattern ───────────────────────────────────────────────────

// Per-tile world size in metres. Texture stays a single unit-cell and
// repeats across the floor — this is what stops the pattern stretching
// when the room aspect doesn't match the canvas (a 4×3 floor with a
// 1:1 canvas previously squashed checker tiles into rectangles).
const FLOOR_TILE_M = 0.5

export function addFloorPattern(group, opts) {
  const { w, depth, floorY, palette, style } = opts
  if (style === 'plain') return
  const tex = floorPatternTexture(style, palette)
  applyFloorRepeat(tex, w, depth, style)
  const geo = new THREE.PlaneGeometry(w * 0.99, depth * 0.99)
  const mat = new THREE.MeshStandardMaterial({
    map: tex, transparent: true, opacity: 0.95, roughness: 0.85,
  })
  const m = new THREE.Mesh(geo, mat)
  m.rotation.x = -Math.PI / 2 // face up
  m.position.set(0, floorY + 0.005, 0)
  // Stash regen info on the group so a palette repaint can rebuild
  // the texture with the new colours without rebuilding geometry.
  group.userData.architecturalFloor = { mesh: m, style, w, depth }
  group.add(m)
}

function applyFloorRepeat(tex, w, depth, style) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  // Per-style world size of one canvas-cell, in metres. Tuned per
  // pattern so each one reads at the right grain.
  const tileM = {
    checker: 0.5,
    diamond: 0.5,
    'subway-tile': 0.4,
    parquet: 0.6,
    plank: 0.6,
    'carpet-tile': 0.5,
    terrazzo: 0.8,
    herringbone: 1.0,
    'linoleum-strip': 0.5,
  }[style] || FLOOR_TILE_M
  if (style === 'linoleum-strip') {
    // Strips run along z only; keep x unrepeated so each strip spans
    // the full width.
    tex.repeat.set(1, Math.max(1, Math.round(depth / tileM)))
  } else {
    tex.repeat.set(
      Math.max(1, Math.round(w / tileM)),
      Math.max(1, Math.round(depth / tileM)),
    )
  }
  tex.needsUpdate = true
}

function floorPatternTexture(style, palette) {
  // Canvas now holds ONE unit cell of the pattern (2×2 squares for
  // checker, one strip cycle for linoleum, one herringbone tile).
  // applyFloorRepeat scales tiling so each cell renders at FLOOR_TILE_M
  // regardless of room dimensions.
  const SIZE = 256
  const c = document.createElement('canvas')
  c.width = c.height = SIZE
  const ctx = c.getContext('2d')
  const a = palette?.floor || '#a89878'
  const b = mix(a, palette?.trim || '#6a4a32', 0.45)
  if (style === 'checker') {
    ctx.fillStyle = a; ctx.fillRect(0, 0, SIZE / 2, SIZE / 2)
    ctx.fillStyle = b; ctx.fillRect(SIZE / 2, 0, SIZE / 2, SIZE / 2)
    ctx.fillStyle = b; ctx.fillRect(0, SIZE / 2, SIZE / 2, SIZE / 2)
    ctx.fillStyle = a; ctx.fillRect(SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2)
  } else if (style === 'diamond') {
    // Same 2-tone idea, but rotated 45° via a diagonal fill so the
    // grain reads as diamond tiles instead of a grid.
    ctx.fillStyle = a; ctx.fillRect(0, 0, SIZE, SIZE)
    ctx.fillStyle = b
    ctx.beginPath()
    ctx.moveTo(SIZE / 2, 0); ctx.lineTo(SIZE, SIZE / 2)
    ctx.lineTo(SIZE / 2, SIZE); ctx.lineTo(0, SIZE / 2); ctx.closePath()
    ctx.fill()
  } else if (style === 'subway-tile') {
    // Running-bond brick: two rows of 2 rectangles, offset by half.
    const grout = mix(b, '#000000', 0.4)
    ctx.fillStyle = grout; ctx.fillRect(0, 0, SIZE, SIZE)
    ctx.fillStyle = a
    const rowH = SIZE / 2, brickW = SIZE / 2
    // Row 0
    ctx.fillRect(2, 2, brickW - 4, rowH - 4)
    ctx.fillRect(brickW + 2, 2, brickW - 4, rowH - 4)
    // Row 1 offset by half
    ctx.fillRect(-brickW / 2 + 2, rowH + 2, brickW - 4, rowH - 4)
    ctx.fillRect(brickW / 2 + 2, rowH + 2, brickW - 4, rowH - 4)
    ctx.fillRect(brickW * 1.5 + 2, rowH + 2, brickW - 4, rowH - 4)
  } else if (style === 'parquet') {
    // Four short plank groups per cell — grain alternates 90° between
    // adjacent quadrants for a classic parquet look.
    const half = SIZE / 2
    const planks = 4
    const drawGroup = (x0, y0, horizontal) => {
      const aa = mix(a, b, 0.15)
      const bb = mix(a, b, 0.35)
      const step = half / planks
      for (let i = 0; i < planks; i += 1) {
        ctx.fillStyle = i % 2 ? aa : bb
        if (horizontal) ctx.fillRect(x0, y0 + i * step, half, step - 1)
        else ctx.fillRect(x0 + i * step, y0, step - 1, half)
      }
    }
    drawGroup(0, 0, true)
    drawGroup(half, 0, false)
    drawGroup(0, half, false)
    drawGroup(half, half, true)
  } else if (style === 'plank') {
    // Long wood planks along z. Canvas holds 4 plank widths at uniform
    // tone with subtle hue variation per plank.
    const planks = 4
    const step = SIZE / planks
    for (let i = 0; i < planks; i += 1) {
      const t = (i * 0.2) % 0.5
      ctx.fillStyle = mix(a, b, 0.1 + t)
      ctx.fillRect(i * step, 0, step - 1, SIZE)
    }
  } else if (style === 'carpet-tile') {
    // Office carpet — 2×2 squares, each with subtle tonal noise so it
    // reads as commercial carpet rather than a tile floor.
    const half = SIZE / 2
    const drawSquare = (x0, y0, base) => {
      ctx.fillStyle = base; ctx.fillRect(x0, y0, half, half)
      // Fine speckle to break up the flat fill.
      ctx.fillStyle = mix(base, '#000000', 0.12)
      for (let i = 0; i < 60; i += 1) {
        const x = x0 + Math.random() * half
        const y = y0 + Math.random() * half
        ctx.fillRect(x, y, 1, 1)
      }
    }
    drawSquare(0, 0, a)
    drawSquare(half, 0, mix(a, b, 0.2))
    drawSquare(0, half, mix(a, b, 0.2))
    drawSquare(half, half, a)
  } else if (style === 'terrazzo') {
    // Base palette colour with small flecks in accent + trim tones.
    const accent = palette?.accent || mix(a, '#ffffff', 0.5)
    ctx.fillStyle = a; ctx.fillRect(0, 0, SIZE, SIZE)
    for (let i = 0; i < 220; i += 1) {
      const r = 2 + Math.random() * 6
      ctx.fillStyle = i % 3 === 0
        ? accent
        : (i % 3 === 1 ? b : mix(a, '#ffffff', 0.4))
      const x = Math.random() * SIZE, y = Math.random() * SIZE
      ctx.beginPath()
      ctx.ellipse(x, y, r, r * (0.6 + Math.random() * 0.4),
        Math.random() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
  } else if (style === 'linoleum-strip') {
    ctx.fillStyle = a; ctx.fillRect(0, 0, SIZE, SIZE / 2)
    ctx.fillStyle = mix(a, b, 0.5); ctx.fillRect(0, SIZE / 2, SIZE, SIZE / 2)
    ctx.strokeStyle = mix(b, '#000000', 0.25)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, SIZE / 2); ctx.lineTo(SIZE, SIZE / 2); ctx.stroke()
    ctx.moveTo(0, SIZE - 1); ctx.lineTo(SIZE, SIZE - 1); ctx.stroke()
  } else if (style === 'herringbone') {
    ctx.fillStyle = a; ctx.fillRect(0, 0, SIZE, SIZE)
    ctx.fillStyle = b
    const W = SIZE / 4, H = SIZE / 12
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        const x = col * W + (row % 2 ? W / 2 : 0)
        const y = row * H
        ctx.fillRect(x, y, W - 4, H - 2)
      }
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/**
 * Rebuild the floor pattern texture from the current palette so a
 * post-mount palette swap (saveLayout → refreshLayoutDressing)
 * actually shows in shelter. Called by buildLayoutDressing.
 */
export function repaintArchitecturalFloor(group, palette) {
  const info = group.userData?.architecturalFloor
  if (!info?.mesh) return
  const oldTex = info.mesh.material?.map
  const tex = floorPatternTexture(info.style, palette)
  applyFloorRepeat(tex, info.w, info.depth, info.style)
  info.mesh.material.map = tex
  info.mesh.material.needsUpdate = true
  oldTex?.dispose?.()
}

// ── helpers ─────────────────────────────────────────────────────────

function makeBox(w, h, d, x, y, z, material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
  m.position.set(x, y, z)
  m.userData.isArchitecturalDetail = true
  return m
}

function mix(hexA, hexB, t) {
  const a = new THREE.Color(hexA)
  const b = new THREE.Color(hexB)
  return '#' + a.lerp(b, t).getHexString()
}

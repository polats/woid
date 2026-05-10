/**
 * One-shot migration: convert static ROOM_TYPES into layout.json files
 * on the bridge. Idempotent — skips rooms that already have a layout
 * unless `--force` is passed.
 *
 * Inference rules:
 *   dimensions: defaults to 6m × 5m × 3m. Bigger defaultGrid bumps up.
 *   palette:    copied straight from the room type.
 *   props:      slot → position grid; kind/size inferred from prompt text.
 *
 * Usage:
 *   node scripts/migrate-room-layouts.mjs            # all unmapped rooms
 *   node scripts/migrate-room-layouts.mjs lobby      # one room
 *   node scripts/migrate-room-layouts.mjs --force    # overwrite
 */

import { ROOM_TYPES } from '../src/lib/shelterWorld/roomTypes.js'
import { PALETTE } from '../src/lib/shelterWorld/officeStyle.js'

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:13457'
const args = process.argv.slice(2)
const force = args.includes('--force')
const filterIds = args.filter((a) => !a.startsWith('--'))

// Default room dimensions in metres. Single-cell defaultGrid → 5×4 room;
// bigger grids scale linearly. Ceiling stays at 3m for the office vibe.
function inferDimensions(rt) {
  const g = rt.defaultGrid || { w: 2, h: 1 }
  return {
    width: Math.max(5.0, g.w * 2.4),
    depth: Math.max(4.0, g.h * 2.4 + 2.0),
    height: 3.0,
  }
}

// Kind classifier — keyword match against the prop id and prompt.
const KIND_RULES = [
  [/(desk|sorting-table|conference-table|table-long|reception)/, 'desk'],
  [/(chair|stool)/, 'chair'],
  [/(monitor|crt|screen|aquarium-monitor)/, 'monitor'],
  [/keyboard/, 'misc'],
  [/(lamp|bulb)/, 'lamp'],
  [/(cabinet|filing|vending|microfiche|founder-bust|pedestal|index-card|machine)/, 'cabinet'],
  [/(shelving|shelf|pigeonhole|bookshelf)/, 'shelf'],
  [/(plant|ficus|fern)/, 'plant'],
  [/(panel|fluorescent|spotlight|track)/, 'fixture'],
  [/(poster|board|directory|painting|mirror|whiteboard|projector|plaque|window|observation)/, 'art'],
  [/(table|round-table)/, 'table'],
  [/(stanchion|rope|partition|cubicle-partition)/, 'partition'],
  [/(stall|hand-dryer|sink|watercooler|cardboard|step-stool|tissue|cart|tube|clipboard|red-object)/, 'misc'],
]

function inferKind(propId, prompt) {
  const hay = `${propId} ${prompt}`.toLowerCase()
  for (const [re, kind] of KIND_RULES) {
    if (re.test(hay)) return kind
  }
  return 'misc'
}

// Bounding-box defaults per kind (metres).
const SIZE_BY_KIND = {
  desk:      { w: 1.2,  h: 0.75, d: 0.7 },
  chair:     { w: 0.55, h: 1.05, d: 0.55 },
  table:     { w: 0.9,  h: 0.75, d: 0.9 },
  monitor:   { w: 0.5,  h: 0.45, d: 0.15 },
  lamp:      { w: 0.3,  h: 0.5,  d: 0.3 },
  cabinet:   { w: 0.6,  h: 1.4,  d: 0.45 },
  shelf:     { w: 1.0,  h: 1.8,  d: 0.4 },
  plant:     { w: 0.45, h: 1.0,  d: 0.45 },
  fixture:   { w: 1.2,  h: 0.05, d: 0.6 },
  art:       { w: 0.8,  h: 1.1,  d: 0.05 },
  partition: { w: 1.2,  h: 1.4,  d: 0.05 },
  misc:      { w: 0.5,  h: 0.5,  d: 0.5 },
}

// Slot → position rule. Returns a generator that yields one position
// per call so multi-prop slots spread out evenly along the axis.
function slotPositioner(slot, count, dims) {
  const halfW = dims.width / 2 - 0.5
  const halfD = dims.depth / 2 - 0.5
  const zBack = -dims.depth / 2 + 0.4
  const zMid  = -0.3
  const zFore =  dims.depth / 2 - 0.7
  const yCeil = dims.height - 0.15

  const xPositions = (n) => {
    if (n <= 1) return [0]
    const start = -halfW
    const step = (2 * halfW) / (n - 1)
    return Array.from({ length: n }, (_, i) => start + i * step)
  }
  const xs = xPositions(count)
  let i = 0

  return () => {
    const x = xs[i++ % xs.length]
    switch (slot) {
      case 'back': return { x, y: 0, z: zBack }
      case 'mid':  return { x, y: 0, z: zMid }
      case 'fore': return { x, y: 0, z: zFore }
      case 'ceil': return { x, y: yCeil, z: 0 }
      default:     return { x, y: 0, z: 0 }
    }
  }
}

function expandProp(prop, slotIndex, slotCounts, dims) {
  // Multi-instance props (count > 1) become N entries with id-i suffixes.
  // Each gets its own position from the slot's positioner.
  const positioner = slotIndex.get(prop.slot)
  const out = []
  const n = prop.count && prop.count > 1 ? prop.count : 1
  for (let k = 0; k < n; k += 1) {
    const kind = inferKind(prop.id, prop.prompt)
    const size = { ...(SIZE_BY_KIND[kind] || SIZE_BY_KIND.misc) }
    const idSuffix = n > 1 ? `-${k + 1}` : ''
    out.push({
      id: `${prop.id}${idSuffix}`,
      kind,
      prompt: prop.prompt,
      position: positioner(),
      rotation_y: 0,
      size,
      materials: [],
    })
  }
  return out
}

function buildLayout(rt) {
  const dims = inferDimensions(rt)
  const palette = {
    wall:   rt.palette?.wall   || rt.color || PALETTE.wallWarm,
    floor:  rt.palette?.floor  || PALETTE.carpetBeige,
    accent: rt.palette?.accent || PALETTE.accentAmber,
    ceiling: PALETTE.ceilingTile,
    trim:    PALETTE.trimWood,
  }

  // Pre-tally counts per slot so positioners spread props evenly.
  const slotCounts = { back: 0, mid: 0, fore: 0, ceil: 0 }
  for (const p of rt.props || []) {
    const n = p.count && p.count > 1 ? p.count : 1
    if (slotCounts[p.slot] != null) slotCounts[p.slot] += n
  }
  const slotIndex = new Map()
  for (const slot of Object.keys(slotCounts)) {
    slotIndex.set(slot, slotPositioner(slot, slotCounts[slot] || 1, dims))
  }

  const props = []
  for (const p of rt.props || []) {
    props.push(...expandProp(p, slotIndex, slotCounts, dims))
  }

  return {
    version: 1,
    id: rt.id,
    name: rt.name,
    description: rt.description || '',
    vibe: rt.vibe || '',
    category: rt.category || 'work',
    dimensions: dims,
    palette,
    materials: {
      wall:    { prompt: `${palette.wall} eggshell paint, slight wear, matte`, tiling: { u: 4, v: 2 } },
      floor:   { prompt: floorPromptFor(rt) },
      ceiling: { prompt: 'off-white acoustic ceiling tiles, regular grid' },
    },
    lighting: {
      fluorescent: { color: '#e8eef0', intensity: 0.55 },
      accent:      { color: palette.accent, intensity: 0.45, positions: [] },
    },
    props,
    seededFrom: 'roomTypes.js',
  }
}

function floorPromptFor(rt) {
  const cat = rt.category
  if (cat === 'work') return 'low-pile teal-grey industrial carpet, slight wear'
  if (cat === 'service') return 'beige linoleum tile floor, fine grout lines'
  if (cat === 'mystery') return 'dark patterned carpet, deep teal with subtle pattern'
  return 'beige low-pile commercial carpet'
}

async function alreadyExists(roomId) {
  try {
    const r = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/layout`)
    return r.ok
  } catch { return false }
}

async function putLayout(layout) {
  const r = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(layout.id)}/layout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(layout),
  })
  if (!r.ok) throw new Error(`PUT ${layout.id} → HTTP ${r.status}: ${await r.text()}`)
  return r.json()
}

;(async () => {
  const rooms = filterIds.length
    ? filterIds.map((id) => ROOM_TYPES[id]).filter(Boolean)
    : Object.values(ROOM_TYPES)
  if (filterIds.length && rooms.length !== filterIds.length) {
    const missing = filterIds.filter((id) => !ROOM_TYPES[id])
    console.error(`[migrate] unknown room ids: ${missing.join(', ')}`)
    process.exit(1)
  }

  console.log(`[migrate] bridge=${BRIDGE_URL} rooms=${rooms.length} force=${force}`)
  let written = 0, skipped = 0, failed = 0
  for (const rt of rooms) {
    if (!force && await alreadyExists(rt.id)) {
      console.log(`[migrate] skip ${rt.id} (already exists; use --force to overwrite)`)
      skipped += 1
      continue
    }
    try {
      const layout = buildLayout(rt)
      const r = await putLayout(layout)
      console.log(`[migrate] wrote ${rt.id} — ${r.propCount} props`)
      written += 1
    } catch (err) {
      console.error(`[migrate] FAIL ${rt.id}: ${err.message}`)
      failed += 1
    }
  }
  console.log(`[migrate] done. written=${written} skipped=${skipped} failed=${failed}`)
})().catch((err) => { console.error(err); process.exit(1) })

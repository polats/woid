import config from '../config.js'

/**
 * Discovers LLM-generated rooms (whose `layout.json` lives on the
 * bridge) and exposes them as buildable types in the shelter's build
 * carousel — separate from the static `ROOM_TYPES` catalogue.
 *
 * Subscribers receive `{ types, ready }` where `types` is an array of
 * synthetic room-type entries shaped like `ROOM_TYPES` values, with an
 * extra `kind: 'generated'` and `layoutId` so the placement flow can
 * route them through the layout-dressing pipeline.
 *
 * Refreshed lazily (first subscriber triggers a fetch). Pull
 * `refresh()` to force a re-poll after a new room is generated.
 */

const BRIDGE_URL = config.agentSandbox?.bridgeUrl || ''
const subscribers = new Set()
let state = { types: [], ready: false }

export function subscribe(fn) {
  subscribers.add(fn)
  fn(state)
  // First subscribe → kick off fetch. Subsequent ones get whatever
  // we already have without re-fetching.
  if (subscribers.size === 1) refresh()
  return () => subscribers.delete(fn)
}

export function getState() { return state }

function emit() { for (const fn of subscribers) fn(state) }

function gridSizeFor(layoutBrief) {
  // Default cell footprint: rough approximation from layout dimensions
  // assuming shelter cellW ≈ cellH ≈ 1 m. Bigger rooms get bigger
  // grid footprints. Clamp 2..6 wide, 1..2 tall for legibility.
  const propCount = layoutBrief.propCount ?? 0
  const gridW = Math.max(2, Math.min(6, Math.round(propCount / 4) + 2))
  const gridH = propCount > 8 ? 2 : 1
  return { gridW, gridH }
}

export async function refresh() {
  if (!BRIDGE_URL) {
    state = { types: [], ready: true }; emit(); return
  }
  try {
    const r = await fetch(`${BRIDGE_URL}/room-layouts`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    const rooms = (j.rooms || []).filter((x) => x.propCount > 0)
    const types = rooms.map((r) => {
      const { gridW, gridH } = gridSizeFor(r)
      return {
        id: `gen:${r.id}`,
        kind: 'generated',
        layoutId: r.id,
        name: r.name || r.id,
        category: 'work',
        defaultBuilt: false,
        tier: 1,
        gridW, gridH,
        color: '#9aa3b0',
        description: `${r.propCount} props · generated`,
        isWork: false,
      }
    })
    state = { types, ready: true }; emit()
  } catch {
    state = { types: [], ready: true }; emit()
  }
}

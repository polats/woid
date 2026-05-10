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

function gridSizeFor(_layoutBrief) {
  // Standardised footprint: same shape as the bundled lobby /
  // pattern-sorting rooms (gridW=2, gridH=1). With cellWidth=2 and
  // cellHeight=1.1 that's a 4 × 1.1 × 3 m shelter cell. The dressing
  // pipeline anisotropically scales the LLM's real-metres layout to
  // fit. Keeps avatar / room proportions matched to the rest of the
  // shelter regardless of prop count.
  return { gridW: 2, gridH: 1 }
}

export async function refresh() {
  if (!BRIDGE_URL) {
    state = { types: [], ready: true }; emit(); return
  }
  try {
    const r = await fetch(`${BRIDGE_URL}/room-layouts`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    // Only rooms explicitly flagged 'added' surface in the shelter
    // build menu. Drafts stay in the room editor only.
    const rooms = (j.rooms || []).filter((x) => x.propCount > 0 && x.status === 'added')
    // Fetch each layout to grab its palette so the placed room paints
    // walls/floor/trim from the LLM-chosen palette instead of a flat
    // fallback grey. Concurrent fetches; failures fall back to defaults.
    const types = await Promise.all(rooms.map(async (r) => {
      const { gridW, gridH } = gridSizeFor(r)
      let palette = null
      try {
        const lr = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(r.id)}/layout`)
        if (lr.ok) {
          const layout = (await lr.json()).layout
          if (layout?.palette) palette = layout.palette
        }
      } catch { /* offline fallback */ }
      return {
        id: `gen:${r.id}`,
        kind: 'generated',
        layoutId: r.id,
        name: r.name || r.id,
        category: 'work',
        defaultBuilt: false,
        tier: 1,
        gridW, gridH,
        color: palette?.accent || '#9aa3b0',
        palette,
        description: `${r.propCount} props · generated`,
        isWork: false,
      }
    }))
    state = { types, ready: true }; emit()
  } catch {
    state = { types: [], ready: true }; emit()
  }
}

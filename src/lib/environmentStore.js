/**
 * Client cache for environment tier plates (the wide-angle FLUX
 * panoramas behind the shelter cells).
 *
 * Mirrors `roomAssetStore` in shape — subscribe + getAll + refresh —
 * so BackgroundLayer can wire to it the same way other consumers wire
 * to room assets.
 */
import config from '../config.js'

const BRIDGE_URL = config.agentSandbox?.bridgeUrl || ''

let state = {}  // tierId → { url, mtime }
const listeners = new Set()

function emit() {
  for (const fn of listeners) {
    try { fn(state) } catch { /* listener errors are not our problem */ }
  }
}

export function getAll() { return state }
export function get(tierId) { return state[tierId] || null }

export function subscribe(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Fetch the bridge's `/v1/environment` inventory and replace the local
 *  cache. Idempotent; safe to call on every shelter mount. */
export async function refresh() {
  if (!BRIDGE_URL) return
  try {
    const r = await fetch(`${BRIDGE_URL}/v1/environment`)
    if (!r.ok) return
    const j = await r.json()
    const next = {}
    for (const t of j.tiers ?? []) {
      next[t.tierId] = { url: t.url, mtime: t.mtime }
    }
    state = next
    emit()
  } catch { /* network blip — keep old state, try again next tick */ }
}

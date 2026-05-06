/**
 * Polling registry that merges the bridge's `/characters` list with
 * the kimodo `/api/kimodo/characters` registry into a single
 * Map<pubkeyHex, CharacterEntry>.
 *
 * Keyed by **hex pubkey** because that's what colyseus presence
 * carries (the room schema stores it under the field `npub`, but the
 * value is actually the hex pubkey — see room-client.js's
 * `joinRoom({ npub: character.pubkey, ... })`). Lookups from the
 * presence-sync effect therefore use hex.
 *
 * Entry shape:
 *   { pubkey, npub, name, avatarUrl,
 *     modelUrl?, modelMtime?,            // bridge static GLB
 *     kimodoCharId?, kimodoUrl?, mapping?, backend? }
 *
 * Subscribers are notified whenever an entry's identity-relevant
 * fields change (modelMtime or kimodoCharId) — that's the signal to
 * invalidate any cached avatar instance for that pubkey.
 *
 * Kimodo failures degrade silently; entries simply lack their kimodo
 * fields and the avatar factory falls back to the static or generic
 * tier.
 */

const POLL_MS = 5000

// Kimodo IDs encode the first 12 hex chars of the raw pubkey
// (`unirig_<pubkey[:12]>_<backend>`). Used only when matching kimodo
// rigs back to bridge characters.
const pubkeyPrefix = (pubkey) => (pubkey || '').slice(0, 12)

export function createCharacterRegistry({ bridgeUrl } = {}) {
  const entries = new Map()
  const listeners = new Set()
  let cancelled = false
  let timer = null

  const emit = (pubkey, prev, next) => {
    for (const fn of listeners) {
      try { fn({ pubkey, prev, next }) } catch (err) {
        console.warn('[characterRegistry] listener threw', err)
      }
    }
  }

  const merge = (bridgeChars, kimodoChars) => {
    // Build a quick lookup from pubkey-prefix → kimodo entry so we can
    // match kimodo rigs against bridge characters by 12-char prefix.
    const kimodoByPrefix = new Map()
    for (const c of kimodoChars ?? []) {
      const m = (c.id ?? '').match(/^unirig_([a-f0-9]{12})_([a-z0-9]+)/)
      if (m) kimodoByPrefix.set(m[1], { ...c, backend: m[2] })
    }
    const seen = new Set()
    for (const ch of bridgeChars ?? []) {
      const pubkey = ch.pubkey
      if (!pubkey) continue
      seen.add(pubkey)
      const kim = kimodoByPrefix.get(pubkeyPrefix(pubkey))
      // The bridge `/characters` response carries `model` as the
      // *LLM* model name (a string), so `ch.model?.modelUrl` is
      // typically undefined. We fall back to constructing the URL
      // from `:pubkey/model` (added by Phase 3 — until then this is
      // a 404 if no model.glb exists, and the factory falls through
      // to the generic avatar.glb).
      const next = {
        pubkey,
        npub: ch.npub ?? null,
        name: ch.name ?? null,
        avatarUrl: ch.avatarUrl ?? (bridgeUrl ? `${bridgeUrl}/characters/${pubkey}/avatar` : null),
        modelUrl: ch.model?.modelUrl ?? (bridgeUrl ? `${bridgeUrl}/characters/${pubkey}/model` : null),
        modelMtime: ch.model?.modelMtime ?? null,
        kimodoCharId: kim?.id ?? ch.model?.kimodoCharId ?? null,
        kimodoUrl: kim?.url ? `/api/kimodo${kim.url}` : null,
        mapping: kim?.mapping ?? null,
        backend: kim?.backend ?? ch.model?.backend ?? null,
      }
      const prev = entries.get(pubkey)
      const changed = !prev
        || prev.modelMtime !== next.modelMtime
        || prev.kimodoCharId !== next.kimodoCharId
        || prev.modelUrl !== next.modelUrl
      entries.set(pubkey, next)
      if (changed) emit(pubkey, prev ?? null, next)
    }
    // Drop entries that disappeared from the bridge.
    for (const pubkey of [...entries.keys()]) {
      if (!seen.has(pubkey)) {
        const prev = entries.get(pubkey)
        entries.delete(pubkey)
        emit(pubkey, prev, null)
      }
    }
  }

  const tick = async () => {
    try {
      const [chars, kim] = await Promise.all([
        bridgeUrl
          ? fetch(`${bridgeUrl}/characters`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
          : Promise.resolve(null),
        fetch('/api/kimodo/characters').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ])
      if (cancelled) return
      merge(chars?.characters ?? null, kim?.characters ?? null)
    } finally {
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }
  }
  tick()

  return {
    /** Snapshot of every known pubkey → entry mapping. */
    snapshot: () => new Map(entries),
    get: (pubkey) => entries.get(pubkey) ?? null,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    dispose() {
      cancelled = true
      if (timer) { clearTimeout(timer); timer = null }
      listeners.clear()
      entries.clear()
    },
  }
}

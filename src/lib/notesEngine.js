/**
 * Notes-quest engine — slice 2.
 *
 * Subscribes to the shelter store, evaluates each character's
 * locked-next condition against fresh state, and POSTs to the
 * bridge's `/characters/:pubkey/notes/unlock` when a condition
 * fires. Storyteller (slice 3) handles generating the next page.
 *
 * Condition vocabulary (must mirror server.js):
 *   reachLevel:         { type, level }
 *   collectionsAtRoom:  { type, roomType, count }
 *   assignedToRoomFor:  { type, roomType, minutes }
 *
 * Cache: per-pubkey `lockedNext` is fetched lazily and reused. On
 * unlock, the response (which now has next:null) replaces the cache
 * entry. Storyteller's PUT to /notes/next isn't observed here yet —
 * once slice 3 wires it, we'll add a refresh hook.
 */
import { levelForXp } from './shelterStore/index.js'
import config from '../config.js'

const cfg = config.agentSandbox || {}
const BRIDGE = cfg.bridgeUrl || 'http://localhost:13457'

// Map<pubkey, { lockedNext: object|null, fetchedAt: number, pending: boolean }>
const cache = new Map()
const CACHE_TTL_MS = 60_000  // refresh after this so new locked-next pages (storyteller PUTs) appear

async function fetchLockedNext(pubkey) {
  const entry = cache.get(pubkey)
  if (entry?.pending) return entry.lockedNext
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) return entry.lockedNext
  cache.set(pubkey, { ...(entry ?? {}), pending: true })
  try {
    const r = await fetch(`${BRIDGE}/characters/${pubkey}/notes`)
    if (!r.ok) {
      cache.set(pubkey, { lockedNext: null, fetchedAt: Date.now(), pending: false })
      return null
    }
    const j = await r.json()
    const lockedNext = j.next ?? null
    cache.set(pubkey, { lockedNext, fetchedAt: Date.now(), pending: false })
    return lockedNext
  } catch (err) {
    console.warn('[notesEngine] fetch failed:', err.message)
    cache.set(pubkey, { lockedNext: null, fetchedAt: Date.now(), pending: false })
    return null
  }
}

/** Hard-clear the cache for one pubkey — call after a PUT or unlock. */
export function invalidateNotesCache(pubkey) {
  cache.delete(pubkey)
}

export function clearNotesCache() {
  cache.clear()
}

/**
 * Evaluate a condition against the current agent state. Returns true
 * when the condition is satisfied. Unknown condition types return
 * false (don't fire and don't crash).
 */
export function evalCondition(condition, agent, snapshot) {
  if (!condition || typeof condition !== 'object') return false
  switch (condition.type) {
    case 'reachLevel': {
      const want = Number(condition.level) || 0
      const have = levelForXp(agent.xp ?? 0)
      return have >= want
    }
    case 'collectionsAtRoom': {
      const want = Number(condition.count) || 0
      const roomType = String(condition.roomType ?? '')
      const have = Number(agent.collectionsByRoom?.[roomType] ?? 0)
      return have >= want
    }
    case 'assignedToRoomFor': {
      const want = Number(condition.minutes) || 0
      const roomType = String(condition.roomType ?? '')
      const assignedRoomId = agent.manualAssignment?.roomId
      if (!assignedRoomId) return false
      const room = snapshot.rooms?.[assignedRoomId]
      const currentRoomType = room?.type ?? assignedRoomId
      if (currentRoomType !== roomType) return false
      const since = Number(agent.assignedSinceSimMin ?? NaN)
      if (!Number.isFinite(since)) return false
      return (snapshot.simMinutes - since) >= want
    }
    default:
      return false
  }
}

/**
 * POST /characters/:pubkey/notes/unlock. Body left empty; storyteller
 * (slice 3) will eventually pre-write the body via PUT /notes/next so
 * this call just promotes-without-override. After a successful unlock
 * we drop the cache so the next eval re-fetches.
 */
async function unlock(pubkey) {
  try {
    const r = await fetch(`${BRIDGE}/characters/${pubkey}/notes/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!r.ok && r.status !== 409) {
      console.warn(`[notesEngine] unlock ${pubkey.slice(0, 12)} HTTP ${r.status}`)
    }
  } catch (err) {
    console.warn('[notesEngine] unlock failed:', err.message)
  } finally {
    invalidateNotesCache(pubkey)
  }
}

/**
 * For every agent whose pubkey is known, fetch (cached) the locked-
 * next page and evaluate its condition. Fires unlock when met.
 * Cheap on the steady state — only one network call per agent per
 * TTL window.
 */
async function evaluateAll(snapshot) {
  const agents = Object.values(snapshot.agents ?? {})
  await Promise.all(agents.map(async (a) => {
    if (!a?.pubkey) return
    let lockedNext
    try { lockedNext = await fetchLockedNext(a.pubkey) }
    catch (err) { console.warn('[notesEngine] fetch threw:', a.name, err.message); return }
    if (!lockedNext) return
    const fired = evalCondition(lockedNext.condition, a, snapshot)
    // Lightweight progress log on every eval so the user can see why
    // unlocks are/aren't firing. Doesn't fire if `fired` is true (the
    // unlock log below takes over).
    if (!fired) {
      console.debug('[notesEngine] eval', a.name, lockedNext.condition, {
        xp: a.xp,
        collectionsByRoom: a.collectionsByRoom,
        manualRoom: a.manualAssignment?.roomId,
      })
      return
    }
    console.log('[notesEngine] UNLOCK', a.name, lockedNext.title)
    await unlock(a.pubkey)
  }))
}

let attachedStoreApi = null
let unsubscribe = null

/**
 * Wire the engine to a live shelter store. Returns an unsubscribe.
 * Re-attaching is a no-op if the same store is passed.
 */
export function attachNotesEngineToStore(storeApi) {
  if (!storeApi || typeof storeApi.subscribe !== 'function') return () => {}
  if (attachedStoreApi === storeApi) return unsubscribe
  if (unsubscribe) try { unsubscribe() } catch {}
  attachedStoreApi = storeApi
  // Evaluate once on attach (in case there's already a met condition
  // from before the engine booted) and on every subsequent commit.
  evaluateAll(storeApi.getSnapshot()).catch(() => {})
  unsubscribe = storeApi.subscribe(() => {
    evaluateAll(storeApi.getSnapshot()).catch(() => {})
  })
  return unsubscribe
}

export function detachNotesEngine() {
  if (unsubscribe) try { unsubscribe() } catch {}
  unsubscribe = null
  attachedStoreApi = null
}

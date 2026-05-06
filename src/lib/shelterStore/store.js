import { OFFLINE_CAP_MIN } from './clock.js'

/**
 * Shelter local-first store.
 *
 * Single JSON blob in localStorage under `woid.shelter.v1`. CRUD
 * operations mutate an in-memory snapshot, persist on every change,
 * and notify subscribers. The shape is the canonical save format —
 * see docs/design/shelter-agents.md for the schema.
 *
 * The store also owns the sim clock: `advanceClock()` rolls
 * `simMinutes` forward by `now − lastTickWallClock`, capped at the
 * offline ceiling. Call it on construction (catch-up after resume)
 * and from a foreground tick loop while the tab is visible.
 *
 * Sync is pluggable. Today the only implementation is `LocalOnlySync`
 * — a no-op that defers to localStorage. Cloud sync drops in later
 * without touching call-sites.
 */

const STORAGE_KEY = 'woid.shelter.v1'
const SCHEMA_VERSION = 1

const blankSnapshot = () => ({
  version: SCHEMA_VERSION,
  lastTickWallClock: Date.now(),
  simMinutes: 0,
  rooms: {},
  agents: {},
  events: [],
})

function readFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== SCHEMA_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

function writeToStorage(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch (err) {
    console.warn('[shelterStore] persist failed', err?.message || err)
  }
}

/** Default sync — local-only no-op. Replace later with a server impl. */
export const LocalOnlySync = {
  async push() {},
  async pull() { return null },
}

export function createShelterStore({ sync = LocalOnlySync } = {}) {
  let snapshot = readFromStorage() ?? blankSnapshot()
  const listeners = new Set()

  // Apply offline catch-up immediately so consumers see a fresh
  // simMinutes on first read. Caps at OFFLINE_CAP_MIN.
  advanceClock()

  function emit() {
    for (const fn of listeners) {
      try { fn(snapshot) } catch (err) {
        console.warn('[shelterStore] listener threw', err?.message || err)
      }
    }
  }

  function commit(next) {
    snapshot = next
    writeToStorage(snapshot)
    emit()
  }

  /**
   * Advance the sim clock based on real-time elapsed since the last
   * call. Called automatically on construction, and intended to run
   * from a foreground tick (e.g. ~4 Hz) while the tab is visible.
   * Returns the number of sim minutes advanced.
   */
  function advanceClock(nowMs = Date.now()) {
    const elapsedMs = Math.max(0, nowMs - snapshot.lastTickWallClock)
    if (elapsedMs < 1000) return 0
    const realSeconds = Math.floor(elapsedMs / 1000)
    // Sim credit is capped at OFFLINE_CAP_MIN; the real-time baseline
    // consumes the full elapsed window so backlog beyond the cap is
    // discarded, not replayed on the next tick. Sub-second remainder
    // (elapsedMs % 1000) is preserved as the next tick's starting
    // gap, so a steady tick loop doesn't accumulate drift.
    const cappedSimMinutes = Math.min(OFFLINE_CAP_MIN, realSeconds)
    snapshot = {
      ...snapshot,
      simMinutes: snapshot.simMinutes + cappedSimMinutes,
      lastTickWallClock: snapshot.lastTickWallClock + realSeconds * 1000,
    }
    writeToStorage(snapshot)
    emit()
    return cappedSimMinutes
  }

  // ── Agents ────────────────────────────────────────────────────────
  function listAgents() {
    return Object.values(snapshot.agents)
  }
  function getAgent(id) {
    return snapshot.agents[id] ?? null
  }
  function addAgent(partial) {
    const id = partial.id ?? `agent-${Math.random().toString(36).slice(2, 10)}`
    if (snapshot.agents[id]) {
      console.warn('[shelterStore] addAgent: duplicate id', id)
      return null
    }
    const agent = {
      id,
      name: partial.name ?? 'Unnamed',
      pubkey: partial.pubkey ?? null,
      llmEnabled: partial.llmEnabled ?? false,
      traits: partial.traits ?? {},
      scheduleId: partial.scheduleId ?? 'worker',
      assignment: partial.assignment ?? null,
      state: partial.state ?? 'idle',
      stateSince: partial.stateSince ?? snapshot.simMinutes,
      pos: partial.pos ?? null,
      // Lerp endpoints recorded at walk-start — used by the renderer
      // to smoothly interpolate world position during
      // `state === 'walking'`. Both cleared by the resolver when the
      // walk settles.
      walkFrom: partial.walkFrom ?? null,
      walkTo: partial.walkTo ?? null,
      // Intra-room pacing endpoints — set by the resolver each pace
      // cycle while the agent is in a steady state (rest/work/social).
      // Lerped by the renderer just like walks. Cleared on state
      // transition and reset each cycle.
      paceFrom: partial.paceFrom ?? null,
      paceTo: partial.paceTo ?? null,
      paceStartedAt: partial.paceStartedAt ?? null,
      relations: partial.relations ?? { parents: [], children: [] },
      createdAt: snapshot.simMinutes,
    }
    commit({ ...snapshot, agents: { ...snapshot.agents, [id]: agent } })
    return agent
  }
  function updateAgent(id, patch) {
    const a = snapshot.agents[id]
    if (!a) return null
    const next = { ...a, ...patch }
    commit({ ...snapshot, agents: { ...snapshot.agents, [id]: next } })
    return next
  }
  function removeAgent(id) {
    if (!snapshot.agents[id]) return false
    const { [id]: _gone, ...rest } = snapshot.agents
    commit({ ...snapshot, agents: rest })
    return true
  }

  // ── Rooms ─────────────────────────────────────────────────────────
  function upsertRoom(roomId, patch) {
    const prev = snapshot.rooms[roomId] ?? { upgradeLevel: 1, productionTimer: 0 }
    const next = { ...prev, ...patch }
    commit({ ...snapshot, rooms: { ...snapshot.rooms, [roomId]: next } })
    return next
  }

  // ── Bulk / sync ───────────────────────────────────────────────────
  function getSnapshot() { return snapshot }
  function clear() {
    commit(blankSnapshot())
  }
  /**
   * Debug-only — bump the sim clock forward by `deltaMinutes`
   * without consuming real wall time. The next behaviour tick
   * picks up the new sim time and re-resolves every agent.
   */
  function fastForward(deltaMinutes) {
    if (!Number.isFinite(deltaMinutes) || deltaMinutes <= 0) return
    commit({ ...snapshot, simMinutes: snapshot.simMinutes + Math.floor(deltaMinutes) })
  }
  async function pushToSync() {
    return sync.push(snapshot)
  }
  async function pullFromSync() {
    const inbound = await sync.pull()
    if (inbound && inbound.version === SCHEMA_VERSION) {
      commit(inbound)
      return true
    }
    return false
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return {
    // reads
    getSnapshot, listAgents, getAgent,
    // mutations
    addAgent, updateAgent, removeAgent, upsertRoom, clear,
    // clock
    advanceClock, fastForward,
    // sync
    pushToSync, pullFromSync,
    // events
    subscribe,
  }
}

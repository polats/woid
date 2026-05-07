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

// Note on NPCs: there is no built-in NPC seed. NPCs are bridge-side
// characters with `kind:'npc'` and the user adds them to a shelter via
// the dev panel (ShelterDebug). The store treats them as ordinary
// agent records with `kind:'npc'` set; tickAgents already skips those.
// Production NPC distribution is documented in docs/design/npc-deploy.md.

const blankSnapshot = () => ({
  version: SCHEMA_VERSION,
  lastTickWallClock: Date.now(),
  simMinutes: 0,
  rooms: {},
  agents: {},
  events: [],
})

/**
 * Build a full agent record from a partial. Single source of truth
 * for the agent shape — used by addAgent (called from the bridge
 * roster), seedDefaults (NPCs), and any future seed paths.
 *
 * Defaults are conservative: no schedule, no pos, no pacing fields.
 * Caller decides what to populate.
 */
function makeAgentRecord(partial, simMinutes) {
  return {
    id: partial.id,
    name: partial.name ?? 'Unnamed',
    // 'employee' covers the player-driven agents that go through the
    // schedule resolver; 'npc' is content (Edi etc.) skipped by tickAgents.
    kind: partial.kind ?? 'employee',
    role: partial.role ?? null,
    pubkey: partial.pubkey ?? null,
    llmEnabled: partial.llmEnabled ?? false,
    traits: partial.traits ?? {},
    scheduleId: partial.scheduleId ?? 'worker',
    assignment: partial.assignment ?? null,
    state: partial.state ?? 'idle',
    stateSince: partial.stateSince ?? simMinutes,
    pos: partial.pos ?? null,
    walkFrom: partial.walkFrom ?? null,
    walkTo: partial.walkTo ?? null,
    paceFrom: partial.paceFrom ?? null,
    paceTo: partial.paceTo ?? null,
    paceStartedAt: partial.paceStartedAt ?? null,
    paceMode: partial.paceMode ?? null,
    paceRestUntil: partial.paceRestUntil ?? null,
    paceRestRole: partial.paceRestRole ?? null,
    relations: partial.relations ?? { parents: [], children: [] },
    createdAt: partial.createdAt ?? simMinutes,
  }
}

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

// Legacy agent ids that were hardcoded as default NPCs in earlier
// versions. Pruned on load so existing localStorage saves don't keep
// rendering ghost NPCs after the hardcoded seed was removed. NPCs
// now come exclusively from the bridge via the dev panel.
const LEGACY_HARDCODED_NPC_IDS = ['edi-schmid']

function pruneLegacyHardcodedNpcs(snapshot) {
  let agents = snapshot.agents
  let mutated = false
  for (const id of LEGACY_HARDCODED_NPC_IDS) {
    if (!agents[id]) continue
    if (!mutated) { agents = { ...agents }; mutated = true }
    delete agents[id]
  }
  if (!mutated) return snapshot
  return { ...snapshot, agents }
}

export function createShelterStore({ sync = LocalOnlySync } = {}) {
  let snapshot = readFromStorage() ?? blankSnapshot()
  // Persist the prune so localStorage stops carrying the legacy entry
  // and reloads don't have to re-clean. pruneLegacyHardcodedNpcs is a
  // no-op for fresh saves, so this only writes when there's actually
  // something to drop.
  const pruned = pruneLegacyHardcodedNpcs(snapshot)
  if (pruned !== snapshot) {
    snapshot = pruned
    writeToStorage(snapshot)
  }
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
    const agent = makeAgentRecord({ ...partial, id }, snapshot.simMinutes)
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

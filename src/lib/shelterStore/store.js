import { OFFLINE_CAP_MIN } from './clock.js'
import { columnsForTier } from './buildingTier.js'

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
  // Player wallet — earned via room.collect, spent via build / upgrade.
  // Persisted across sessions like everything else in the snapshot.
  cash: 0,
  // Player-side XP. Each collect bumps this alongside the per-worker
  // xp; the player's level is derived via levelForXp() and surfaces
  // in the bottom-of-screen XP bar + level-up celebration.
  playerXp: 0,
  // Player-built rooms — placed by Build Mode. Bundled-layout rooms
  // (lobby, pattern-sorting) are NOT in this list; the stage merges
  // both lists at render time. Each entry has the same shape as the
  // layout entries: { id, name, type, gridX, gridY, gridW, gridH, color }.
  builtRooms: [],
  // Building tier — the player-facing progression metric (1..N).
  // Tier 1 is the starter shelter; upgrades bump this and rewrite
  // `columns` via setBuildingTier().
  buildingTier: 1,
  // Column footprint of the shelter. Each entry is a vertical slice
  // of buildable space: { gridX, gridW, maxFloor }. Layout rooms
  // pre-fill specific positions inside columns; player builds in the
  // rest. setBuildingTier writes this through via the tier curve;
  // setColumns overrides directly without touching the tier label
  // (demo / scenario use).
  columns: columnsForTier(1),
})

/**
 * XP curve — triangular / quadratic.
 *
 * Level N requires `(N-1) * N / 2 * 100` cumulative xp:
 *   L1: 0      L2: 100    L3: 300    L4: 600
 *   L5: 1000   L6: 1500   L10: 4500  L20: 19000
 *
 * Each level costs +100 xp more than the previous one — i.e. with the
 * pattern-sorting reward of 100 xp per collection, leveling takes 1,
 * 2, 3, 4, … collections. Tutorial still gets its "first collect =
 * first level-up" beat for free.
 *
 * Inverse closed-form: solve `(N-1)·N/2·100 ≤ xp` for the largest N.
 */
export function levelForXp(xp) {
  const x = Math.max(0, xp)
  // Discriminant of (N-1)·N/2·100 = x → N² - N - x/50 = 0
  //   N = (1 + sqrt(1 + 4·x/50)) / 2
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * x) / 50)) / 2))
}

/** Cumulative xp required to *reach* level N. xpAtLevel(1) = 0. */
export function xpAtLevel(level) {
  const n = Math.max(1, Math.floor(level))
  return ((n - 1) * n / 2) * 100
}

// ── Room progression ─────────────────────────────────────────────────
// Rooms have their own level (1-10) that grows with use. Each
// collection bumps the room's xp by 1; the room's level then sets a
// multiplier on the *player* xp reward, alongside a static tier
// multiplier from the catalogue. Higher tiers level slower but pay
// better when matured.

const ROOM_LEVEL_CAP = 10

/** Static reward multiplier by tier. Tier 1 = canonical, +0.5 per tier. */
export function tierMultiplier(tier) {
  const t = Math.max(1, Math.floor(tier ?? 1))
  return 0.5 + t * 0.5  // 1→1.0, 2→1.5, 3→2.0, 4→2.5
}

/** Collections required per room level, scaled by tier. */
export function roomXpPerLevel(tier) {
  const t = Math.max(1, Math.floor(tier ?? 1))
  return ({ 1: 5, 2: 8, 3: 12, 4: 18 })[t] ?? 5 + (t - 1) * 4
}

/** Room level from its xp counter. Capped at ROOM_LEVEL_CAP. */
export function roomLevelForXp(roomXp, tier) {
  const x = Math.max(0, roomXp ?? 0)
  const per = roomXpPerLevel(tier)
  return Math.min(ROOM_LEVEL_CAP, 1 + Math.floor(x / per))
}

/** Room xp required to *reach* room level L (xp counter, not the player one). */
export function roomXpAtLevel(level, tier) {
  const n = Math.min(ROOM_LEVEL_CAP, Math.max(1, Math.floor(level)))
  return (n - 1) * roomXpPerLevel(tier)
}

/** Bonus multiplier from the room's current level. Level 1 = base. */
export function roomLevelMultiplier(level) {
  const n = Math.max(1, Math.floor(level ?? 1))
  return 1 + 0.25 * (n - 1)  // L1=1.0, L5=2.0, L10=3.25
}

/**
 * Player xp paid out by one collection.
 *   playerRewardXp = baseXp · tierMultiplier(tier) · roomLevelMultiplier(level)
 *
 * Caller passes the catalogue's base xp + tier; the store fetches the
 * room's current level from its snapshot.
 */
export function playerRewardXpFor(baseXp, tier, level) {
  return Math.round(
    Math.max(0, Number(baseXp) || 0)
    * tierMultiplier(tier)
    * roomLevelMultiplier(level),
  )
}

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
    // assignment        — resolver's current placement, written each tick
    //                     ({ roomId, role }). Fluctuates with the schedule.
    // manualAssignment  — player's sticky choice ({ roomId }). The
    //                     resolver respects it during `work` slots; rest /
    //                     social still go through the schedule's defaults
    //                     so the day-night cycle still has weight.
    assignment: partial.assignment ?? null,
    manualAssignment: partial.manualAssignment ?? null,
    xp: partial.xp ?? 0,
    // Per-room collection counter — bumped on every collectRoom for
    // an assigned worker. Keyed by roomType (the catalogue id, e.g.
    // "pattern-sorting"), not room instance id. Used by the notes
    // engine to evaluate `collectionsAtRoom` quest conditions.
    collectionsByRoom: partial.collectionsByRoom ?? {},
    // Sim-time when this character's manualAssignment was set.
    // Cleared when assignment changes. Used by the notes engine to
    // evaluate `assignedToRoomFor` quest conditions.
    assignedSinceSimMin: partial.assignedSinceSimMin ?? null,
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

  /**
   * Player-built room. The entry is appended to `builtRooms` with a
   * unique id so ShelterStage3D can detect new rooms vs already-
   * rendered ones. Costs deducted by the caller — the store stays
   * dumb about pricing rules.
   */
  function addBuiltRoom(entry) {
    if (!entry?.id || !entry?.type) {
      console.warn('[shelterStore] addBuiltRoom: id + type required', entry)
      return null
    }
    const list = snapshot.builtRooms ?? []
    if (list.some((r) => r.id === entry.id)) {
      console.warn('[shelterStore] addBuiltRoom: duplicate id', entry.id)
      return null
    }
    commit({ ...snapshot, builtRooms: [...list, entry] })
    return entry
  }

  /**
   * Wipe all player-built rooms — layout rooms (lobby, pattern-sorting)
   * stay since they're not in this list. Used by the tutorial host so
   * a re-run starts with the original two-room shelter.
   */
  function clearBuiltRooms() {
    if ((snapshot.builtRooms ?? []).length === 0) return
    commit({ ...snapshot, builtRooms: [] })
  }

  /**
   * Set the building tier (1..N) and write the matching column list
   * through to `columns` via the curve. Use `setColumns` to override
   * the column list without touching the tier label (demo / scenario).
   */
  function setBuildingTier(tier) {
    const next = Math.max(1, Math.round(tier || 1))
    const columns = columnsForTier(next)
    if (snapshot.buildingTier === next
        && JSON.stringify(snapshot.columns) === JSON.stringify(columns)) return
    commit({ ...snapshot, buildingTier: next, columns })
  }

  /**
   * Override the column list directly. The tier label stays unchanged.
   * Used by demo / trailer scenarios that don't follow progression.
   */
  function setColumns(columns) {
    if (!Array.isArray(columns)) return
    const cleaned = columns.map((c) => ({
      gridX: Number(c.gridX) || 0,
      gridW: Math.max(1, Number(c.gridW) || 2),
      maxFloor: Math.max(0, Number(c.maxFloor) || 0),
    }))
    if (JSON.stringify(snapshot.columns) === JSON.stringify(cleaned)) return
    commit({ ...snapshot, columns: cleaned })
  }

  /**
   * Wipe all rooms' production state — productionTimer back to 0,
   * productionReady back to false. Used by the tutorial host so the
   * bar starts empty on a re-run instead of inheriting partial fill
   * (or a stuck "ready" coin) from the previous pass.
   */
  function resetRoomProduction() {
    const rooms = snapshot.rooms ?? {}
    let mutated = false
    const next = {}
    for (const [id, r] of Object.entries(rooms)) {
      if ((r.productionTimer ?? 0) === 0 && !r.productionReady) {
        next[id] = r
        continue
      }
      next[id] = { ...r, productionTimer: 0, productionReady: false }
      mutated = true
    }
    if (!mutated) return
    commit({ ...snapshot, rooms: next })
  }

  // ── Rooms ─────────────────────────────────────────────────────────
  function upsertRoom(roomId, patch) {
    const prev = snapshot.rooms[roomId] ?? {
      upgradeLevel: 1,
      productionTimer: 0,
      productionReady: false,
    }
    const next = { ...prev, ...patch }
    commit({ ...snapshot, rooms: { ...snapshot.rooms, [roomId]: next } })
    return next
  }

  // ── Assignment + production ──────────────────────────────────────
  /**
   * Player-set worker assignment. Stored on `manualAssignment` so the
   * resolver's per-tick `assignment` writes can't clobber it; the
   * resolver reads `manualAssignment` and routes the agent to that
   * room for work slots only (decision 2c).
   */
  function setAssignment(agentId, roomId) {
    const a = snapshot.agents[agentId]
    if (!a) return null
    // Only reset `assignedSinceSimMin` when the room actually changes —
    // re-assigning to the same room shouldn't restart the dwell clock.
    const sameRoom = a.manualAssignment?.roomId === roomId
    const next = {
      ...a,
      manualAssignment: { roomId },
      assignedSinceSimMin: sameRoom ? (a.assignedSinceSimMin ?? snapshot.simMinutes) : snapshot.simMinutes,
      // Reset walk/pace state so the next tick re-routes them
      // toward the new room cleanly.
      walkFrom: null, walkTo: null,
      paceFrom: null, paceTo: null,
      paceMode: null, paceStartedAt: null,
      paceRestUntil: null, paceRestRole: null,
    }
    commit({ ...snapshot, agents: { ...snapshot.agents, [agentId]: next } })
    return next
  }

  /**
   * Wipe player-side progression to a fresh state — playerXp = 0,
   * level derived as 1. Used by the tutorial host so a re-run starts
   * cleanly: the recruit's first collect crosses the level-1→2
   * threshold without overshooting from leftover XP.
   *
   * Doesn't touch cash, agent xp, or rooms — those are gameplay
   * outcomes and should persist unless explicitly reset elsewhere.
   */
  function resetPlayerProgress() {
    const hasPlayerXp = !!snapshot.playerXp
    const hasRoomProgress = Object.values(snapshot.rooms ?? {}).some(
      (r) => (r?.xp ?? 0) > 0 || (r?.level ?? 1) > 1,
    )
    if (!hasPlayerXp && !hasRoomProgress) return
    const nextRooms = {}
    for (const [id, r] of Object.entries(snapshot.rooms ?? {})) {
      nextRooms[id] = { ...r, xp: 0, level: 1 }
    }
    commit({ ...snapshot, playerXp: 0, rooms: nextRooms })
  }

  function clearAssignment(agentId) {
    const a = snapshot.agents[agentId]
    if (!a) return null
    const next = { ...a, manualAssignment: null, assignedSinceSimMin: null }
    commit({ ...snapshot, agents: { ...snapshot.agents, [agentId]: next } })
    return next
  }

  /**
   * Collect production from a ready room. Pays out `rewardCash` to
   * the player wallet and `rewardXp` to each assigned worker, then
   * resets the room's timer + ready flag. No-op if the room isn't
   * ready or doesn't exist.
   *
   * The room-type catalogue is the source of truth for reward
   * amounts — passed in by the caller so the store stays decoupled
   * from `roomTypes.js`.
   */
  function collectRoom(roomId, { rewardCash = 0, rewardXp = 0, tier = 1 } = {}) {
    const room = snapshot.rooms[roomId]
    if (!room || !room.productionReady) return null
    const assigned = Object.values(snapshot.agents).filter(
      (a) => a.manualAssignment?.roomId === roomId
    )

    // Room progression — +1 to the room's xp counter on every collect.
    // The level is derived from the counter using the tier-scaled
    // threshold (5/8/12/18 collections per level).
    const prevRoomXp = room.xp ?? 0
    const prevRoomLevel = roomLevelForXp(prevRoomXp, tier)
    const nextRoomXp = prevRoomXp + 1
    const nextRoomLevel = roomLevelForXp(nextRoomXp, tier)
    const roomLeveledUp = nextRoomLevel > prevRoomLevel

    // Per-worker xp — scaled the same way the player's xp is, so
    // worker xp keeps tracking the player's curve. Also bumps the
    // worker's `collectionsByRoom[roomType]` so the notes engine can
    // evaluate `collectionsAtRoom` quest conditions.
    const playerXpPerWorker = playerRewardXpFor(rewardXp, tier, prevRoomLevel)
    const roomType = room.type ?? roomId
    const nextAgents = { ...snapshot.agents }
    for (const a of assigned) {
      const prevByRoom = a.collectionsByRoom ?? {}
      nextAgents[a.id] = {
        ...a,
        xp: (a.xp ?? 0) + playerXpPerWorker,
        collectionsByRoom: {
          ...prevByRoom,
          [roomType]: (prevByRoom[roomType] ?? 0) + 1,
        },
      }
    }

    const nextRooms = {
      ...snapshot.rooms,
      [roomId]: {
        ...room,
        productionTimer: 0,
        productionReady: false,
        xp: nextRoomXp,
        level: nextRoomLevel,
      },
    }
    const totalXp = playerXpPerWorker * Math.max(1, assigned.length)
    commit({
      ...snapshot,
      cash: (snapshot.cash ?? 0) + rewardCash,
      // Player-side XP scales with worker count so multi-slot rooms
      // (later) are correctly more rewarding.
      playerXp: (snapshot.playerXp ?? 0) + totalXp,
      agents: nextAgents,
      rooms: nextRooms,
    })
    return {
      rewardCash,
      rewardXp: playerXpPerWorker,
      totalXp,
      roomId,
      workerIds: assigned.map((a) => a.id),
      roomLevel: nextRoomLevel,
      roomLeveledUp,
    }
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
    setAssignment, clearAssignment, collectRoom, resetPlayerProgress,
    addBuiltRoom, clearBuiltRooms, resetRoomProduction, setBuildingTier, setColumns,
    // clock
    advanceClock, fastForward,
    // sync
    pushToSync, pullFromSync,
    // events
    subscribe,
  }
}

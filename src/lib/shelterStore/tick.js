import { resolveAgentState } from './resolver.js'
import { getRoomType } from '../shelterWorld/roomTypes.js'

// Sim-minutes credited per behaviour tick. The hook fires at 4 Hz,
// so over a wall-second we get ~4 ticks → 4 sim-minutes (matches
// SIM_MINUTES_PER_REAL_SECOND). Capped so a slow tab doesn't dump
// huge amounts of production from a single tick.
const PRODUCTION_TICK_MIN = 1
const PRODUCTION_TICK_CAP = 4

/**
 * Run one behaviour tick across the whole agent set.
 *
 * Called from the foreground tick loop. Walks every agent, asks
 * `resolveAgentState` for the patch needed, and writes back via
 * `store.updateAgent`. No-op for agents already in steady state.
 *
 * Also advances per-room production timers for rooms with at least
 * one manually-assigned worker present and in a `work` state. When
 * a room hits its `productionDuration`, it flips `productionReady`
 * and stops accumulating until the player collects.
 *
 * Separate from the clock tick — clock and behaviour run at the
 * same rate but the split keeps the resolver pure / testable.
 */
export function tickAgents(store) {
  const snapshot = store.getSnapshot()
  for (const agent of Object.values(snapshot.agents)) {
    // NPCs (e.g. the Receptionist Edi Schmid) are content, not
    // simulated — they have a fixed pos, no schedule, and the
    // resolver should never try to walk them anywhere.
    if (agent.kind === 'npc') continue
    const patch = resolveAgentState(agent, snapshot.simMinutes)
    if (patch) store.updateAgent(agent.id, patch)
  }
  tickProduction(store)
}

function tickProduction(store) {
  const snapshot = store.getSnapshot()
  // Build a roomId → type-id resolver. Layout rooms (lobby /
  // pattern-sorting) have id === type so getRoomType(id) just
  // works; player-built rooms have unique ids (`mail-room-<ts>`)
  // and carry a separate `type` field on the builtRooms entry.
  const builtTypeOf = new Map()
  for (const r of snapshot.builtRooms ?? []) {
    if (r?.id && r?.type) builtTypeOf.set(r.id, r.type)
  }
  const roomTypeFor = (roomId) => getRoomType(builtTypeOf.get(roomId) ?? roomId)

  // Group manually-assigned, currently-working agents by their room.
  const byRoom = new Map()
  for (const a of Object.values(snapshot.agents)) {
    const roomId = a.manualAssignment?.roomId
    if (!roomId) continue
    if (a.state !== 'work') continue
    if (a.assignment?.roomId !== roomId) continue
    const list = byRoom.get(roomId) ?? []
    list.push(a)
    byRoom.set(roomId, list)
  }
  for (const [roomId, workers] of byRoom) {
    const type = roomTypeFor(roomId)
    if (!type?.isWork) continue
    const room = snapshot.rooms[roomId] ?? {
      upgradeLevel: 1, productionTimer: 0, productionReady: false,
    }
    // Per-room override wins over the type default — used by the demo
    // seeder to stagger production durations across the building.
    const dur = Number(room.productionDuration ?? type.productionDuration ?? 0)
    if (!dur) continue
    if (room.productionReady) continue
    // Linear contribution per worker, capped by tick to keep things
    // smooth even after a long pause.
    const advance = Math.min(PRODUCTION_TICK_CAP, PRODUCTION_TICK_MIN * workers.length)
    const nextTimer = Math.min(dur, room.productionTimer + advance)
    const ready = nextTimer >= dur
    if (nextTimer === room.productionTimer && !ready) continue
    store.upsertRoom(roomId, {
      productionTimer: nextTimer,
      productionReady: ready,
    })
  }
}

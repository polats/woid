import { resolveSchedule } from './schedules.js'

/**
 * Per-agent state-machine driver.
 *
 * Given an agent and the current sim time, produce a *patch* — the
 * minimum set of fields to write back into the store to bring the
 * agent into alignment with their schedule. Returns `null` when no
 * change is needed (the common case once steady-state is reached).
 *
 * State machine:
 *   - schedule slot says (room A, action X), agent is already there
 *     and doing X → no patch
 *   - slot says (room A, action X), agent is in room B → start
 *     walking: state='walking', assignment.roomId=A,
 *     stateSince=simMinutes
 *   - state='walking' AND elapsed >= WALK_DURATION_MIN → settle in
 *     destination: state=X, pos within room, stateSince=simMinutes
 *   - same room, different action (e.g. work → social in same room
 *     would only happen with custom schedules, but cheap to handle)
 *     → state=X, stateSince=simMinutes
 *
 * Position is deterministic per (agentId, action) so agents fan out
 * across stations without colliding.
 */

export const WALK_DURATION_MIN = 5    // sim minutes — feels like 5 real seconds
// Pacing — intra-room idle wandering. Agents in a steady state
// (rest/work/social) alternate between a `moving` phase (PACE_DURATION_MIN
// sim minutes lerping to a fresh in-room waypoint) and a `resting` phase
// (random duration in [PACE_REST_MIN_MIN, PACE_REST_MAX_MIN], holding the
// last waypoint and playing 'idle' or 'wave'). Phase + role are
// deterministic per (agentId, restCycle) so the resolver is reproducible.
export const PACE_DURATION_MIN = 3
export const PACE_REST_MIN_MIN = 1
export const PACE_REST_MAX_MIN = 4
const PACE_REST_ROLES = ['idle', 'wave']

// Stable hash for deterministic positioning. Same agent + same
// action always lands at the same spot. Avalanche finalizer (Murmur3
// style) mixes the bits hard — without it, single-character changes
// in the input (like incrementing the cycle index) only flip the LSB,
// which then gets masked by `& 0xffff` into a near-identical u/v.
// That made consecutive pace cycles pick waypoints right on top of
// each other and the lerp produced a constant value.
function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) | 0
  }
  // Murmur3 finalizer — diffuse input bits across all output bits.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) | 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) | 0
  h ^= h >>> 16
  return h >>> 0
}

function deterministicPos(agentId, action, roomId) {
  const h = hashCode(`${agentId}:${action}:${roomId}`)
  // Inset 0.2..0.8 so agents don't clip walls.
  const localU = 0.2 + ((h & 0xffff) / 0xffff) * 0.6
  const localV = 0.2 + (((h >>> 16) & 0xffff) / 0xffff) * 0.6
  return { roomId, localU, localV }
}

// Per-cycle pacing waypoint. Same agent + room + cycle index always
// picks the same spot, so the resolver is reproducible across ticks
// during the cycle. The cycle index advances every move/rest pair,
// producing a fresh-looking sequence of in-room waypoints.
function pacePos(agentId, roomId, cycle) {
  const h = hashCode(`${agentId}:${roomId}:pace:${cycle}`)
  const localU = 0.2 + ((h & 0xffff) / 0xffff) * 0.6
  const localV = 0.2 + (((h >>> 16) & 0xffff) / 0xffff) * 0.6
  return { roomId, localU, localV }
}

// Random rest duration + role per cycle, deterministic by (agent, cycle).
// Hashing on cycle (a sim-minute floor) means the same agent at the same
// cycle picks the same role / duration on every recompute — important
// because the resolver runs each tick and we don't want to re-roll mid-rest.
function pickRestRole(agentId, cycle) {
  const h = hashCode(`${agentId}:rest:role:${cycle}`)
  return PACE_REST_ROLES[h & (PACE_REST_ROLES.length - 1)] ?? 'idle'
}
function pickRestDuration(agentId, cycle) {
  const h = hashCode(`${agentId}:rest:dur:${cycle}`)
  const norm = (h & 0xffff) / 0xffff
  return PACE_REST_MIN_MIN + norm * (PACE_REST_MAX_MIN - PACE_REST_MIN_MIN)
}

const STEADY_STATES = new Set(['rest', 'work', 'social'])

/**
 * Compute the patch (or null) for one agent at `simMinutes`.
 * Pure function; the caller writes the patch back via the store.
 */
export function resolveAgentState(agent, simMinutes) {
  const slot = resolveSchedule(agent.scheduleId, simMinutes)
  const inRoom = agent.assignment?.roomId ?? null

  if (inRoom === null) {
    // First-tick placement for a freshly added agent — drop them
    // directly into the right room, no walk.
    return {
      state: slot.action,
      stateSince: simMinutes,
      assignment: { roomId: slot.roomId, role: slot.action },
      pos: deterministicPos(agent.id, slot.action, slot.roomId),
    }
  }

  if (agent.state === 'walking') {
    const elapsed = simMinutes - (agent.stateSince ?? simMinutes)
    if (elapsed < WALK_DURATION_MIN) return null
    // Walk done — settle into destination. We trust agent.walkTo if
    // set (cheaper than recomputing); fall back to deterministicPos
    // for resilience against legacy records.
    const destRoomId = inRoom ?? slot.roomId
    return {
      state: slot.action,
      stateSince: simMinutes,
      pos: agent.walkTo
        ?? deterministicPos(agent.id, slot.action, destRoomId),
      // Walk is over — drop both endpoints so the renderer's tween
      // logic stops trying to interpolate.
      walkFrom: null,
      walkTo: null,
      // Fresh steady state — clear any stale pacing fields so the
      // pacing loop kicks off cleanly from the destination.
      paceFrom: null,
      paceTo: null,
      paceStartedAt: null,
      paceMode: null,
      paceRestUntil: null,
      paceRestRole: null,
    }
  }

  if (inRoom !== slot.roomId) {
    // Different room — start walking. Capture both endpoints up
    // front: walkFrom = current pos (so the renderer knows where
    // to lerp from), walkTo = the deterministic destination pos
    // (so the renderer knows where to lerp to without recomputing).
    // Falls back to a deterministic pos in the source room if the
    // agent has no recorded pos yet (defensive — the null-inRoom
    // branch above normally handles fresh agents).
    return {
      state: 'walking',
      stateSince: simMinutes,
      assignment: { roomId: slot.roomId, role: slot.action },
      walkFrom: agent.pos
        ?? deterministicPos(agent.id, agent.state ?? 'idle', inRoom),
      walkTo: deterministicPos(agent.id, slot.action, slot.roomId),
    }
  }

  if (agent.state !== slot.action) {
    return {
      state: slot.action,
      stateSince: simMinutes,
      pos: deterministicPos(agent.id, slot.action, slot.roomId),
      // Reset any in-flight pacing — destination room/state changed.
      paceFrom: null,
      paceTo: null,
      paceStartedAt: null,
      paceMode: null,
      paceRestUntil: null,
      paceRestRole: null,
    }
  }

  // ── Intra-room pacing ──────────────────────────────────────────
  // Two-phase loop:
  //   moving   → lerp paceFrom → paceTo over PACE_DURATION_MIN min,
  //              role 'walk'.
  //   resting  → hold at the just-reached waypoint for a random
  //              duration in [PACE_REST_MIN_MIN, PACE_REST_MAX_MIN],
  //              role 'idle' or 'wave' (deterministic per cycle).
  //
  // Cycle index = floor(simMinutes); guaranteed monotonic so each
  // moving→resting transition gets a fresh waypoint, role, and
  // duration without us having to track an explicit counter.
  if (STEADY_STATES.has(agent.state) && inRoom) {
    if (agent.paceMode === 'moving') {
      // Currently walking toward a waypoint. When the move window
      // elapses, settle at paceTo and start a rest period.
      const paceElapsed = agent.paceStartedAt != null
        ? simMinutes - agent.paceStartedAt
        : Infinity
      if (paceElapsed >= PACE_DURATION_MIN) {
        const cycle = Math.floor(simMinutes)
        return {
          pos: agent.paceTo ?? agent.pos
            ?? deterministicPos(agent.id, agent.state, inRoom),
          paceFrom: null,
          paceTo: null,
          paceStartedAt: null,
          paceMode: 'resting',
          paceRestUntil: simMinutes + pickRestDuration(agent.id, cycle),
          paceRestRole: pickRestRole(agent.id, cycle),
        }
      }
      return null
    }

    if (agent.paceMode === 'resting') {
      // Stationary; once the rest period ends, pick a fresh waypoint
      // and start the next move.
      if (simMinutes >= (agent.paceRestUntil ?? simMinutes)) {
        const cycle = Math.floor(simMinutes)
        const next = pacePos(agent.id, inRoom, cycle)
        const from = agent.pos
          ?? deterministicPos(agent.id, agent.state, inRoom)
        return {
          paceFrom: from,
          paceTo: next,
          paceStartedAt: simMinutes,
          paceMode: 'moving',
          paceRestUntil: null,
          paceRestRole: null,
        }
      }
      return null
    }

    // First entry to a steady state — kick off the loop with a move.
    const cycle = Math.floor(simMinutes)
    const next = pacePos(agent.id, inRoom, cycle)
    const from = agent.pos
      ?? deterministicPos(agent.id, agent.state, inRoom)
    return {
      paceFrom: from,
      paceTo: next,
      paceStartedAt: simMinutes,
      paceMode: 'moving',
      paceRestUntil: null,
      paceRestRole: null,
    }
  }

  return null
}

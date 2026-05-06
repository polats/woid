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

export const WALK_DURATION_MIN = 5  // sim minutes — feels like 5 real seconds

// Cheap stable hash for deterministic positioning. Same agent +
// same action always lands at the same spot.
function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) | 0
  }
  return h >>> 0
}

function deterministicPos(agentId, action, roomId) {
  const h = hashCode(`${agentId}:${action}:${roomId}`)
  // Inset 0.2..0.8 so agents don't clip walls.
  const localU = 0.2 + ((h & 0xffff) / 0xffff) * 0.6
  const localV = 0.2 + (((h >>> 16) & 0xffff) / 0xffff) * 0.6
  return { roomId, localU, localV }
}

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
    // Walk done — settle into destination (the assignment was set
    // when the walk started; trust it over re-resolving the slot).
    const destRoomId = inRoom ?? slot.roomId
    return {
      state: slot.action,
      stateSince: simMinutes,
      pos: deterministicPos(agent.id, slot.action, destRoomId),
    }
  }

  if (inRoom !== slot.roomId) {
    // Different room — start walking. Update assignment immediately
    // so the destination is committed; pos retains the old room
    // until walk completes (Phase 1 has no corridor render anyway).
    return {
      state: 'walking',
      stateSince: simMinutes,
      assignment: { roomId: slot.roomId, role: slot.action },
    }
  }

  if (agent.state !== slot.action) {
    return {
      state: slot.action,
      stateSince: simMinutes,
      pos: deterministicPos(agent.id, slot.action, slot.roomId),
    }
  }

  return null
}

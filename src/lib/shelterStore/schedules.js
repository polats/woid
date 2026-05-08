/**
 * Schedule templates — what an agent does at each hour of the
 * sim-day. Slots are sorted by `from` (minutes-since-midnight).
 *
 * The resolver picks the slot whose `from` is closest below the
 * agent's current sim-minutes. Slots wrap at the day boundary —
 * the last slot covers from its `from` through the next day's
 * first slot. So a schedule must include a slot that begins at
 * minute 0 (or the wrap will leave a gap) — every template here
 * does.
 *
 * Roles for now: `worker`. Add `manager`, `visitor`, etc. later.
 *
 * Slot actions map directly onto agent FSM states ('rest', 'work',
 * 'social'). The FSM also tracks 'walking', 'idle', 'event' which
 * aren't slot-emitted — see resolver.js.
 */

export const SLOT_ACTIONS = ['rest', 'work', 'social']

// Single-room layout for now — every slot routes to the lobby.
// When more rooms come back online, restore the per-action room ids
// (the resolver and FSM already understand multi-room schedules).
export const SCHEDULES = {
  worker: [
    { from:  0 * 60, action: 'rest',   roomId: 'lobby' },
    { from:  7 * 60, action: 'work',   roomId: 'lobby' },
    { from: 12 * 60, action: 'social', roomId: 'lobby' },
    { from: 13 * 60, action: 'work',   roomId: 'lobby' },
    { from: 18 * 60, action: 'social', roomId: 'lobby' },
    { from: 21 * 60, action: 'rest',   roomId: 'lobby' },
  ],
}

/**
 * Resolve the active slot for `scheduleId` at sim time
 * `simMinutes`. Returns a `{ from, action, roomId }` slot.
 */
export function resolveSchedule(scheduleId, simMinutes) {
  const slots = SCHEDULES[scheduleId] ?? SCHEDULES.worker
  const minOfDay = ((simMinutes % 1440) + 1440) % 1440
  let active = slots[slots.length - 1]
  for (const slot of slots) {
    if (slot.from <= minOfDay) active = slot
    else break
  }
  return active
}

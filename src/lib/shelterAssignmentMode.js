/**
 * Assignment-mode signal.
 *
 * When the player taps "Assign" on a character card, the card calls
 * `start(agentId)`. Listeners (the stage, the character card) read
 * the active state to render tap-targets and dim/hide UI as needed.
 * The stage commits the room choice via `commit(roomId)` which calls
 * the registered handler, OR the player cancels via `cancel()`.
 *
 * Module-scoped so the card and the stage don't have to plumb props
 * through Shelter.jsx — they import the signal directly. Mirrors the
 * shelterStageBus and tutorial runtime patterns.
 */

const subscribers = new Set()
let state = { active: false, agentId: null }
let onCommit = null

function emit() {
  for (const fn of subscribers) {
    try { fn(state) } catch (err) { console.warn('[assignmentMode]', err) }
  }
}

export function getState() { return state }
export function subscribe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/**
 * Begin assignment mode. The provided callback receives the chosen
 * roomId when the player taps a room (via commit) — the caller is
 * responsible for actually writing the assignment to the store.
 */
export function start(agentId, commit) {
  if (!agentId) return
  onCommit = typeof commit === 'function' ? commit : null
  state = { active: true, agentId }
  emit()
}

/** Bail out — the player tapped Cancel or pressed Escape. */
export function cancel() {
  onCommit = null
  state = { active: false, agentId: null }
  emit()
}

/** Stage hands the room choice to the in-flight assignment. */
export function commit(roomId) {
  if (!state.active) return
  const fn = onCommit
  onCommit = null
  const agentId = state.agentId
  state = { active: false, agentId: null }
  emit()
  if (fn && roomId) {
    try { fn({ agentId, roomId }) } catch (err) { console.warn('[assignmentMode]', err) }
  }
}

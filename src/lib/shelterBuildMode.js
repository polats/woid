/**
 * Build-mode signal — mirrors shelterAssignmentMode.
 *
 * Two-stage flow:
 *   1. Player taps the Build tab. Module flips `active: true`.
 *      Carousel slides down with build-eligible room types.
 *   2. Player taps a card in the carousel.
 *      `selectedType` is set; the stage renders ghost cells at
 *      every valid placement position.
 *   3. Player taps a ghost cell. The stage calls `commitPlacement`
 *      with the chosen grid coords; the registered onPlace callback
 *      writes the room to the store and exits the mode.
 *   4. Or the player cancels (Build tab again, X on carousel,
 *      ESC key) — `cancel()` clears state.
 *
 * State shape:
 *   { active: bool, selectedType: string | null }
 *
 * Module-scoped subscriber set, same pattern as shelterStageBus and
 * shelterAssignmentMode.
 */

const subscribers = new Set()
let state = { active: false, selectedType: null }
let onPlace = null   // ({ type, gridX, gridY }) → void

function emit() {
  for (const fn of subscribers) {
    try { fn(state) } catch (err) { console.warn('[shelterBuildMode]', err) }
  }
}

export function getState() { return state }
export function subscribe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/**
 * Begin Build Mode. The provided callback receives the chosen
 * placement when the player taps a ghost cell — the caller is
 * responsible for actually writing the new room to the store.
 */
export function start(onPlaceCb) {
  onPlace = typeof onPlaceCb === 'function' ? onPlaceCb : null
  state = { active: true, selectedType: null }
  emit()
}

/** Player tapped a card in the carousel. Arms placement mode. */
export function selectType(type) {
  if (!state.active) return
  state = { ...state, selectedType: type ?? null }
  emit()
}

/** Player tapped a ghost cell. Hands the placement to the registered handler. */
export function commitPlacement(coords) {
  if (!state.active || !state.selectedType || !coords) return
  const fn = onPlace
  const placed = { type: state.selectedType, ...coords }
  state = { active: false, selectedType: null }
  onPlace = null
  emit()
  if (fn) {
    try { fn(placed) } catch (err) { console.warn('[shelterBuildMode]', err) }
  }
}

/** Bail without building (tab toggle, X, ESC). */
export function cancel() {
  onPlace = null
  state = { active: false, selectedType: null }
  emit()
}

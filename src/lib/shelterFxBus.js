/**
 * Lightweight event bus for transient UI effects on the Shelter
 * stage — coin-fly animations from a collect, level-up celebrations,
 * and similar one-shot visuals that don't belong in persistent store
 * state.
 *
 * Producers call `emit(eventType, payload)` and the FX layer (a React
 * subscriber) renders short-lived elements that animate + unmount.
 *
 * Mirrors the shelterStageBus / tutorial-runtime patterns: module-
 * scoped Set of listeners, fire-and-forget.
 */

const subscribers = new Set()

export function subscribe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/**
 * `flyCash` — a coin animates from (fromX, fromY) on screen toward
 *   the cash counter, fades out on arrival.
 *   payload: { amount, fromX, fromY,
 *              burstIndex?, burstTotal?,  // optional for coin bursts
 *              showAmount? }              // render "¤N" on this coin
 *
 * `rewardPopup` — floating "+¤<amount>" label that rises and fades
 *   above the collected room.
 *   payload: { amount, fromX, fromY }
 *
 * `cashBump` — short scale pulse on the cash counter when coins land.
 *   payload: {}
 *
 * `roomBuilt` — celebration when a new room is placed by the player.
 *   Emits a ring shockwave, sparkle particles, and a "BUILT" popup
 *   at the room's screen position.
 *   payload: { roomId, fromX, fromY }
 *
 * `levelUp` — celebration overlay. Triggered when playerXp crosses
 *   a level threshold.
 *   payload: { fromLevel, toLevel }
 */
export function emit(type, payload) {
  for (const fn of subscribers) {
    try { fn({ type, payload }) } catch (err) {
      console.warn('[shelterFxBus]', err)
    }
  }
}

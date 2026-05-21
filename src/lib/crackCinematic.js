/**
 * "Crack" cinematic — the demo's reveal beat.
 *
 * Pans the camera to a top-down overview of the whole building,
 * shakes the screen, then slowly scrolls down. While the scroll
 * runs, the overlay layer draws cracks across the bottom floors
 * and amber light bleeds through them, hinting at hidden
 * backrooms behind the shelter walls.
 *
 * Triggered from ShelterDebug's "Crack" button. Subscribers (the
 * Shelter shell + the cinematic overlay) read `active` to mount
 * the visual layer and apply the screen-shake class.
 */
import { panCameraTo, cameraTo } from './shelterStageBus.js'

let state = { active: false, startedAt: 0 }
const listeners = new Set()

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getState() { return state }

function set(next) {
  state = { ...state, ...next }
  for (const fn of listeners) fn(state)
}

// Total duration the overlay element should think it's playing.
// Camera pan + holds add up to roughly this; the overlay uses it
// only for self-fade timing so the cracks ease out cleanly.
export const CRACK_DURATION_MS = 12500
// Camera-pan beats — kept here so the in-scene shader render loop
// (ShelterStage3D) can reference the same numbers when deriving
// the crack-reveal window.
export const DESCENT_START_MS = 2100
export const DESCENT_LEN_MS = 8200
// Cracks hold off for 2 s after the descent begins so the camera
// has visibly moved before the floor splits.
export const REVEAL_DELAY_AFTER_DESCENT_MS = 2000
export const REVEAL_LEN_MS = 7200

let inFlight = null

export function playCrackCinematic({ cellH = 1.1 } = {}) {
  if (inFlight) return inFlight
  set({ active: true, startedAt: performance.now() })
  inFlight = (async () => {
    try {
      // Pull back to the whole-shelter overview ("home" framing).
      // cameraTo computes the fit zoom from the building bounds, so
      // we get an actual full-building shot regardless of how tall
      // the tower is — no hand-tuned zoom number to drift on.
      await cameraTo({ state: 'home', ms: 1200 })
      // Tension hold — descent begins at DESCENT_START_MS.
      await new Promise((r) => setTimeout(r, 900))
      // Slow descent toward the ground row. We deliberately pass
      // only `y` so panCameraTo preserves the zoom that cameraTo
      // 'home' just established — otherwise an explicit zoom here
      // overrides the fit framing and we lose the wide overview.
      await panCameraTo({ y: cellH * 0.8, ms: DESCENT_LEN_MS })
      // Lingering hold on the amber glow.
      await new Promise((r) => setTimeout(r, 2000))
    } finally {
      set({ active: false, startedAt: 0 })
      inFlight = null
    }
  })()
  return inFlight
}

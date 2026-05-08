/**
 * Module-scoped command bus for ShelterStage3D.
 *
 * The stage is a long-lived WebGL renderer with its focus / camera
 * machinery captured inside a setup effect's closure. To let outside
 * code (e.g. the tutorial runtime) drive that machinery without
 * threading callbacks through every layer, the stage registers a
 * handler here on mount and outside callers post commands.
 *
 * If no stage is mounted, commands silently no-op — same behaviour as
 * sending an event to a closed listener.
 */

let handler = null

export function registerStageHandler(fn) {
  handler = fn
  return () => { if (handler === fn) handler = null }
}

/**
 * @param {string} agentId
 * @param {{outline?: boolean, motionRole?: string|null, closeup?: boolean}} [opts]
 *   outline    — apply red selection outline (default true)
 *   motionRole — role tag to play on focus, or null to skip (default 'wave')
 *   closeup    — cinematic full-body framing, no outline drift, no pan
 */
export function focusAgent(agentId, opts) {
  if (handler) handler({ type: 'focusAgent', agentId, opts })
}

export function exitFocus() {
  if (handler) handler({ type: 'exitFocus' })
}

/**
 * Animate an agent's wrapper position over `ms`, playing the 'walk'
 * motion for the duration. Returns a promise that resolves when the
 * walk completes (or immediately if no stage is mounted).
 */
export function walkAgent({ pubkey, dx = 0, dy = 0, ms = 1500 } = {}) {
  if (!handler || !pubkey) return Promise.resolve()
  return new Promise((resolve) => {
    handler({ type: 'walkAgent', pubkey, dx, dy, ms, onComplete: resolve })
  })
}

/**
 * Pan the camera by (dx, dy) over `ms` ms. Used by the tutorial to
 * follow / overshoot a walking character.
 */
export function panCamera({ dx = 0, dy = 0, ms = 1500 } = {}) {
  if (!handler) return Promise.resolve()
  return new Promise((resolve) => {
    handler({ type: 'panCamera', dx, dy, ms, onComplete: resolve })
  })
}

/**
 * Tween the camera to a NAMED framing state without clearing the
 * current focus state — focusRole / focusedAgentIdRef stay intact so
 * the sync loop keeps Edi in arms-crossed during the zoom out.
 *
 * State names match the CAMERA_STATE constants exported from
 * ShelterStage3D: 'home' (whole-shelter overview), 'room' (the
 * focused agent's room framing), 'closeup' (bbox tight on agent).
 */
export function cameraTo({ state = 'room', ms = 1500 } = {}) {
  if (!handler) return Promise.resolve()
  return new Promise((resolve) => {
    handler({ type: 'cameraTo', state, ms, onComplete: resolve })
  })
}

/**
 * Drop any cinematic-only avatar overrides so the next sync tick
 * snaps every agent back to its store-driven position + role. Used
 * by tutorial reset / play start so a re-run of the wake-up doesn't
 * inherit Edi's off-screen-left position from the previous run.
 */
export function clearTutorialOverrides() {
  if (!handler) return Promise.resolve()
  return new Promise((resolve) => {
    handler({ type: 'clearTutorialOverrides', onComplete: resolve })
  })
}

/**
 * Walk an agent in from an offset position relative to current frame.
 * The handler positions the agent off-camera at `fromOffsetX` first,
 * then walks them by `dx`. Used for the new-recruit-arrival cinematic.
 */
export function walkInAgent({ pubkey, fromOffsetX = 1.5, dx = -1.5, ms = 2500 } = {}) {
  if (!handler || !pubkey) return Promise.resolve()
  return new Promise((resolve) => {
    handler({ type: 'walkInAgent', pubkey, fromOffsetX, dx, ms, onComplete: resolve })
  })
}

// True when a stage is currently mounted and listening on the bus.
// Used by the tutorial host to detect the no-stage case for tests.
export function hasStageHandler() {
  return handler !== null
}

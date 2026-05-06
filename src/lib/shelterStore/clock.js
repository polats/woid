/**
 * Shelter sim clock.
 *
 * Two reference frames:
 * - Wall clock — JS `Date.now()`, ms.
 * - Sim minutes — monotonic integer minutes since the vault was founded.
 *
 * Conversion: 1 real second = 1 sim minute (so 1 real minute = 1 sim
 * hour, and a sim day takes 24 real minutes). On resume, sim time is
 * advanced by `min(OFFLINE_CAP_MIN, elapsed)` so closing the app for a
 * week doesn't fast-forward seven sim days.
 */

export const SIM_MINUTES_PER_REAL_SECOND = 1
export const OFFLINE_CAP_MIN = 12 * 60   // 12 sim hours

export const realMsToSimMinutes = (ms) =>
  Math.floor((ms / 1000) * SIM_MINUTES_PER_REAL_SECOND)

/**
 * Compute how many sim minutes to advance given the time elapsed
 * since `lastTickWallClock`. Caps at OFFLINE_CAP_MIN.
 */
export function simMinutesToAdvance(lastTickWallClock, nowMs = Date.now()) {
  if (!lastTickWallClock || lastTickWallClock <= 0) return 0
  const elapsedMs = Math.max(0, nowMs - lastTickWallClock)
  const raw = realMsToSimMinutes(elapsedMs)
  return Math.min(OFFLINE_CAP_MIN, raw)
}

/**
 * Format `simMinutes` as a 24-hour clock-of-day string ("13:42")
 * for debug UI. Day rolls over at 24*60 = 1440 sim minutes.
 */
export function formatSimTime(simMinutes) {
  const m = ((simMinutes % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Day index since vault founded (0-based). */
export const simDay = (simMinutes) => Math.floor(simMinutes / 1440)

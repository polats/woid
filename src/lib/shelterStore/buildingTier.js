/**
 * Building-tier progression curve, column-based.
 *
 * A "column" is a vertical slice of buildable space: `{ gridX, gridW,
 * maxFloor }` — the slot grid for the column spans `gridY = 0..maxFloor`.
 * Layout rooms (lobby, pattern-sorting) pre-fill specific positions
 * inside columns; player builds rooms in the unfilled positions.
 *
 * The progression is tall-then-wide-then-taller — early tiers grow
 * upward in the starter columns, mid tiers add new columns to the right
 * (horizontal expansion), and late tiers extend everything. Different
 * column heights produce a stepped silhouette.
 *
 * Demo / scenario code can bypass the curve via `setColumns()` on the
 * store; the curve is just the default progression.
 */

export const TIER_MIN = 1
export const TIER_MAX = 5

export const TIER_CURVE = [
  // Tier 1 — starter shelter, two columns above the lobby + pattern-
  // sorting ground rooms.
  { tier: 1, columns: [
    { gridX: 0, gridW: 2, maxFloor: 5 },
    { gridX: 2, gridW: 2, maxFloor: 5 },
  ]},
  // Tier 2 — taller, still narrow.
  { tier: 2, columns: [
    { gridX: 0, gridW: 2, maxFloor: 10 },
    { gridX: 2, gridW: 2, maxFloor: 10 },
  ]},
  // Tier 3 — first horizontal unlock. Adds a 3rd column at gridX=4
  // that only reaches floor 5 (stepped pyramid). This is what the
  // trailer demo uses.
  { tier: 3, columns: [
    { gridX: 0, gridW: 2, maxFloor: 15 },
    { gridX: 2, gridW: 2, maxFloor: 15 },
    { gridX: 4, gridW: 2, maxFloor: 5 },
  ]},
  // Tier 4 — extend the 3rd column.
  { tier: 4, columns: [
    { gridX: 0, gridW: 2, maxFloor: 20 },
    { gridX: 2, gridW: 2, maxFloor: 20 },
    { gridX: 4, gridW: 2, maxFloor: 15 },
  ]},
  // Tier 5 — 4th column appears, pyramid taper.
  { tier: 5, columns: [
    { gridX: 0, gridW: 2, maxFloor: 25 },
    { gridX: 2, gridW: 2, maxFloor: 25 },
    { gridX: 4, gridW: 2, maxFloor: 20 },
    { gridX: 6, gridW: 2, maxFloor: 10 },
  ]},
]

/**
 * Resolve a tier integer to its `columns` list. Out-of-range values
 * clamp to [TIER_MIN, TIER_MAX].
 */
export function columnsForTier(tier) {
  const clamped = Math.max(TIER_MIN, Math.min(TIER_MAX, Math.round(tier || TIER_MIN)))
  // Return a fresh copy so callers can't accidentally mutate the curve.
  return TIER_CURVE[clamped - 1].columns.map((c) => ({ ...c }))
}

/**
 * Level-up unlock table.
 *
 * Each entry is keyed by the level the player reaches and lists the
 * perks the level unlocks. The level-up celebration UI reads this
 * to render a "New Perks" section under the level transition.
 *
 * Perk shapes:
 *   { type: 'room', id }   — a room type from shelterWorld/roomTypes.js
 *
 * The room-type catalogue stays the source of truth for name +
 * description; we just point at it by id.
 */

import { getRoomType } from './shelterWorld/roomTypes.js'

const LEVEL_PERKS = {
  2: [{ type: 'room', id: 'break-room' }],
}

/**
 * Fully resolve perks for a level — looks up referenced data so the
 * UI can render without re-importing room types.
 *
 * Returns an array of { type, name, description } (more fields as
 * future perk types come online).
 */
export function perksForLevel(level) {
  const list = LEVEL_PERKS[level]
  if (!list) return []
  const out = []
  for (const p of list) {
    if (p.type === 'room') {
      const rt = getRoomType(p.id)
      if (rt) {
        out.push({
          type: 'room',
          id: p.id,
          name: rt.name,
          description: rt.description ?? '',
        })
      }
    }
  }
  return out
}

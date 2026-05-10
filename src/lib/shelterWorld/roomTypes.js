/**
 * Room type registry for Shelter (Severance-mode game).
 *
 * Distinct from `shelter-layout.json`, which describes which rooms are
 * *placed* on the grid. This file describes the *types* — their
 * category, the tier at which they unlock, what the build menu shows,
 * what each room contributes to gameplay, and the prop list that drives
 * the asset-generation pipeline (FLUX → TRELLIS, see officeStyle.js).
 *
 * `defaultBuilt` tells the layout loader which rooms appear at game
 * start. `tier` is the facility-tier threshold required to surface
 * this type in the build menu.
 *
 * IDs are stable — they appear in shelter-layout.json, tutorial scripts,
 * and player save state. Renames require a migration.
 *
 * Aesthetic: Severance / Stanley Parable / 1980s corporate retro-future.
 * Every prop prompt is implicitly prefixed with STYLE_PROMPT_PREFIX from
 * officeStyle.js — keep `prompt` fields terse and concrete.
 */

import { PALETTE } from './officeStyle.js'

export const ROOM_CATEGORY = {
  lobby: 'lobby',
  work: 'work',
  service: 'service',
  mystery: 'mystery',
}

/** Prop slot — where in the room shell the asset sits.
 *    back  — flush against the back wall (filing cabinets, posters)
 *    mid   — main floor plane (desks, chairs, tables)
 *    fore  — closest to camera, low (rugs, plants, boxes)
 *    ceil  — overhead (light panels, vents, signage) */
export const PROP_SLOT = { back: 'back', mid: 'mid', fore: 'fore', ceil: 'ceil' }

export const ROOM_TYPES = {
  lobby: {
    id: 'lobby',
    name: 'Reception',
    category: ROOM_CATEGORY.lobby,
    description: 'The reception floor. Edi Schmid greets new hires here.',
    vibe: 'Please wait. Someone will be with you shortly.',
    defaultBuilt: true,
    tier: 1,
    isWork: false,
    palette: { wall: PALETTE.wallWarm, floor: PALETTE.carpetBeige, accent: PALETTE.accentAmber },
    props: [
      { id: 'reception-desk', slot: 'mid', prompt: 'curved laminate reception desk, beige top, dark wood base' },
      { id: 'visitor-chair-pair', slot: 'fore', prompt: 'two tubular-frame waiting-room chairs, teal vinyl seats', count: 2 },
      { id: 'fake-ficus', slot: 'fore', prompt: 'artificial ficus tree in beige planter' },
      { id: 'directory-board', slot: 'back', prompt: 'wall-mounted black felt directory board with white peg letters' },
      { id: 'fluorescent-panel', slot: 'ceil', prompt: 'recessed fluorescent ceiling light panel' },
    ],
  },
  'pattern-sorting': {
    id: 'pattern-sorting',
    name: 'Pattern Sorting',
    category: ROOM_CATEGORY.work,
    description:
      'Sorters refine numerical patterns whose meaning is need-to-know. '
      + "Don't ask what the numbers mean.",
    vibe: 'The work is mysterious and important.',
    defaultBuilt: true,
    tier: 1,
    isWork: true,
    workstationCount: 1,
    capacity: 1,
    productionDuration: 10,
    rewardCash: 100,
    rewardXp: 100,
    palette: { wall: PALETTE.wallWarm, floor: PALETTE.carpetTeal, accent: PALETTE.accentGreen },
    props: [
      { id: 'mdr-desk', slot: 'mid', prompt: 'beige laminate office desk with cable grommet' },
      { id: 'crt-monitor-beige', slot: 'mid', prompt: 'beige 1980s CRT monitor with green phosphor screen' },
      { id: 'mdr-keyboard', slot: 'mid', prompt: 'beige mechanical keyboard, oversized keys, trackball beside it' },
      { id: 'office-chair-swivel', slot: 'mid', prompt: 'tubular-frame swivel office chair, teal cloth seat' },
      { id: 'desk-lamp-banker', slot: 'mid', prompt: 'green glass banker\'s desk lamp with brass base' },
      { id: 'fluorescent-panel', slot: 'ceil', prompt: 'recessed fluorescent ceiling light panel' },
    ],
  },
  'break-room': {
    id: 'break-room',
    name: 'Break Room',
    category: ROOM_CATEGORY.service,
    description: 'A small room for restoring energy between shifts.',
    vibe: 'Please enjoy each food item equally.',
    defaultBuilt: false,
    tier: 2,
    isWork: false,
    defaultGrid: { w: 2, h: 1 },
    color: '#a8b8a8',
    energyRestorePerMin: 20,
    palette: { wall: PALETTE.wallCool, floor: PALETTE.linoleumGrey, accent: PALETTE.accentAmber },
    props: [
      { id: 'round-table-laminate', slot: 'mid', prompt: 'small round laminate break-room table, single chrome pedestal' },
      { id: 'plastic-chair-stack', slot: 'mid', prompt: 'molded plastic stacking chair, beige', count: 2 },
      { id: 'vending-machine', slot: 'back', prompt: '1980s snack vending machine, beige with glass front' },
      { id: 'watercooler-bottle', slot: 'back', prompt: 'inverted-bottle watercooler, beige base, blue bottle' },
      { id: 'motivational-poster', slot: 'back', prompt: 'framed motivational poster, beige matte, small text' },
    ],
  },
}

/** All registered type ids in declaration order. */
export const ROOM_TYPE_IDS = Object.keys(ROOM_TYPES)

/** Lookup helper. Returns null on unknown id. */
export function getRoomType(id) {
  return ROOM_TYPES[id] ?? null
}

/** Flat list of every prop reference across every room type, with the
 *  owning room id attached. Useful for the asset-pipeline UI to surface
 *  generation status and for de-duplicating shared props (`mdr-desk`,
 *  `office-chair-swivel`, `fluorescent-panel` recur across rooms). */
export function listAllPropRefs() {
  const out = []
  for (const room of Object.values(ROOM_TYPES)) {
    if (!room.props) continue
    for (const prop of room.props) {
      out.push({ roomId: room.id, ...prop })
    }
  }
  return out
}

/** Unique prop ids across all rooms — the actual generation work units.
 *  A prop appearing in N rooms still only generates once. */
export function listUniquePropIds() {
  const seen = new Set()
  for (const room of Object.values(ROOM_TYPES)) {
    if (!room.props) continue
    for (const prop of room.props) seen.add(prop.id)
  }
  return [...seen]
}

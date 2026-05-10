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
    name: 'Macrodata Refinement',
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
  // ── Office rooms (tier-1 buildable) ────────────────────────────
  'mail-room': {
    id: 'mail-room',
    name: 'Mail Room',
    category: ROOM_CATEGORY.work,
    description: 'Inter-office correspondence and pneumatic dispatch.',
    vibe: 'All envelopes find their floor.',
    defaultBuilt: false,
    tier: 1,
    isWork: true,
    defaultGrid: { w: 2, h: 1 },
    color: '#cdb88a',
    productionDuration: 8,
    rewardCash: 60,
    rewardXp: 8,
    capacity: 1,
    palette: { wall: PALETTE.wallWarm, floor: PALETTE.linoleumGrey, accent: PALETTE.accentAmber },
    props: [
      { id: 'pigeonhole-wall', slot: 'back', prompt: 'wall of small wooden pigeonhole mail slots, dozens of compartments' },
      { id: 'sorting-table', slot: 'mid', prompt: 'long laminate sorting table with raised edge' },
      { id: 'mail-cart', slot: 'fore', prompt: 'canvas-sided mail cart on casters, beige frame' },
      { id: 'pneumatic-tube', slot: 'back', prompt: 'brass pneumatic tube terminal mounted to wall' },
    ],
  },
  'archives': {
    id: 'archives',
    name: 'Archives',
    category: ROOM_CATEGORY.work,
    description: 'Stacked microfiche, indexed by quarter. Authorised access only.',
    vibe: 'Quarter four is missing. It is best not to ask.',
    defaultBuilt: false,
    tier: 1,
    isWork: true,
    defaultGrid: { w: 2, h: 1 },
    color: '#7a7466',
    productionDuration: 20,
    rewardCash: 180,
    rewardXp: 25,
    capacity: 1,
    palette: { wall: PALETTE.wallDim, floor: PALETTE.carpetBeige, accent: PALETTE.accentAmber },
    props: [
      { id: 'filing-cabinet-4drawer', slot: 'back', prompt: 'beige metal four-drawer filing cabinet with label slots', count: 3 },
      { id: 'microfiche-reader', slot: 'mid', prompt: 'beige microfiche reader machine with hooded screen' },
      { id: 'index-card-cabinet', slot: 'back', prompt: 'wooden card-catalog cabinet with brass label holders' },
      { id: 'step-stool-library', slot: 'fore', prompt: 'short wooden library step stool' },
    ],
  },
  'wellness-counsel': {
    id: 'wellness-counsel',
    name: 'Wellness Session',
    category: ROOM_CATEGORY.service,
    description: 'Calm, encouraging conversation about productivity targets.',
    vibe: 'Your father loved you. He often said so, in his way.',
    defaultBuilt: false,
    tier: 1,
    isWork: false,
    defaultGrid: { w: 2, h: 1 },
    color: '#9cb8b0',
    palette: { wall: PALETTE.wallCool, floor: PALETTE.carpetBeige, accent: PALETTE.accentGreen },
    props: [
      { id: 'wingback-chair', slot: 'mid', prompt: 'single upholstered wingback chair, muted teal fabric' },
      { id: 'aquarium-monitor', slot: 'back', prompt: 'CRT television showing aquarium screensaver, on small cart' },
      { id: 'tissue-box-stand', slot: 'fore', prompt: 'small side table with tissue box and water glass' },
      { id: 'wall-painting-bland', slot: 'back', prompt: 'framed bland landscape painting, muted tones' },
    ],
  },
  'storage': {
    id: 'storage',
    name: 'Supply Closet',
    category: ROOM_CATEGORY.work,
    description: 'Locked cabinets, numbered by department. Inventory updated weekly.',
    vibe: 'Take only what is requisitioned.',
    defaultBuilt: false,
    tier: 1,
    isWork: true,
    defaultGrid: { w: 2, h: 1 },
    color: '#8a7a6a',
    productionDuration: 25,
    rewardCash: 220,
    rewardXp: 30,
    capacity: 1,
    palette: { wall: PALETTE.wallDim, floor: PALETTE.linoleumGrey, accent: PALETTE.accentAmber },
    props: [
      { id: 'metal-shelving-unit', slot: 'back', prompt: 'industrial grey metal shelving unit, five shelves with boxes', count: 2 },
      { id: 'cardboard-box-stack', slot: 'mid', prompt: 'stack of unlabeled beige cardboard boxes' },
      { id: 'clipboard-on-hook', slot: 'back', prompt: 'clipboard with inventory sheet hanging on metal hook' },
      { id: 'single-bare-bulb', slot: 'ceil', prompt: 'single bare incandescent bulb on porcelain socket' },
    ],
  },
  'refinement-floor': {
    id: 'refinement-floor',
    name: 'Refinement Floor',
    category: ROOM_CATEGORY.work,
    description: 'A larger pattern-sorting bay. Four desks face inward.',
    vibe: 'The numbers are scary. The numbers are kind.',
    defaultBuilt: false,
    tier: 1,
    isWork: true,
    defaultGrid: { w: 2, h: 1 },
    color: '#c0b0a0',
    productionDuration: 15,
    rewardCash: 140,
    rewardXp: 18,
    capacity: 1,
    palette: { wall: PALETTE.wallWarm, floor: PALETTE.carpetTeal, accent: PALETTE.accentGreen },
    props: [
      { id: 'mdr-desk', slot: 'mid', prompt: 'beige laminate office desk with cable grommet', count: 4 },
      { id: 'crt-monitor-beige', slot: 'mid', prompt: 'beige 1980s CRT monitor with green phosphor screen', count: 4 },
      { id: 'office-chair-swivel', slot: 'mid', prompt: 'tubular-frame swivel office chair, teal cloth seat', count: 4 },
      { id: 'fluorescent-panel', slot: 'ceil', prompt: 'recessed fluorescent ceiling light panel', count: 2 },
    ],
  },
  // ── New office archetypes ──────────────────────────────────────
  'cubicle-farm': {
    id: 'cubicle-farm',
    name: 'Cubicle Farm',
    category: ROOM_CATEGORY.work,
    description: 'A grid of beige partitions. Each station identical to the last.',
    vibe: 'Productivity is a posture.',
    defaultBuilt: false,
    tier: 2,
    isWork: true,
    defaultGrid: { w: 3, h: 2 },
    color: '#bfae8e',
    productionDuration: 12,
    rewardCash: 110,
    rewardXp: 14,
    capacity: 2,
    palette: { wall: PALETTE.wallWarm, floor: PALETTE.carpetBeige, accent: PALETTE.accentAmber },
    props: [
      { id: 'cubicle-partition', slot: 'mid', prompt: 'beige fabric cubicle partition wall, half height', count: 3 },
      { id: 'cubicle-desk-corner', slot: 'mid', prompt: 'L-shaped beige laminate cubicle desk', count: 2 },
      { id: 'office-chair-swivel', slot: 'mid', prompt: 'tubular-frame swivel office chair, teal cloth seat', count: 2 },
      { id: 'paper-stack-tower', slot: 'mid', prompt: 'leaning tower of manila folders and paperwork' },
      { id: 'fluorescent-panel', slot: 'ceil', prompt: 'recessed fluorescent ceiling light panel', count: 2 },
    ],
  },
  'conference-room': {
    id: 'conference-room',
    name: 'Conference Room',
    category: ROOM_CATEGORY.work,
    description: 'Long table, projector screen, and a clock on the wall.',
    vibe: 'This meeting could have been a memo.',
    defaultBuilt: false,
    tier: 2,
    isWork: false,
    defaultGrid: { w: 3, h: 1 },
    color: '#b8a890',
    palette: { wall: PALETTE.wallWarm, floor: PALETTE.carpetBeige, accent: PALETTE.accentAmber },
    props: [
      { id: 'conference-table-long', slot: 'mid', prompt: 'long oval conference table, dark wood veneer top, chrome base' },
      { id: 'office-chair-swivel', slot: 'mid', prompt: 'tubular-frame swivel office chair, teal cloth seat', count: 6 },
      { id: 'projector-screen-pull', slot: 'back', prompt: 'pull-down projector screen mounted to wall, partially extended' },
      { id: 'whiteboard-frame', slot: 'back', prompt: 'aluminum-framed whiteboard, faint marker ghosts' },
      { id: 'wall-clock-institutional', slot: 'back', prompt: 'round institutional wall clock, white face, black hands' },
    ],
  },
  'restroom': {
    id: 'restroom',
    name: 'Restroom',
    category: ROOM_CATEGORY.service,
    description: 'Three stalls, two sinks, one mirror that does not lie.',
    vibe: 'Wash thoroughly. Return promptly.',
    defaultBuilt: false,
    tier: 2,
    isWork: false,
    defaultGrid: { w: 2, h: 1 },
    color: '#bcc2bc',
    energyRestorePerMin: 8,
    palette: { wall: PALETTE.wallCool, floor: PALETTE.linoleumGrey, accent: PALETTE.accentGreen },
    props: [
      { id: 'restroom-stall-divider', slot: 'back', prompt: 'beige metal toilet stall divider with door', count: 2 },
      { id: 'porcelain-sink', slot: 'mid', prompt: 'wall-mounted porcelain sink with chrome fixtures' },
      { id: 'wall-mirror-rectangular', slot: 'back', prompt: 'plain rectangular wall mirror in thin metal frame' },
      { id: 'hand-dryer-wall', slot: 'back', prompt: 'wall-mounted beige hand dryer unit' },
    ],
  },
  'perpetuity-wing': {
    id: 'perpetuity-wing',
    name: 'Perpetuity Wing',
    category: ROOM_CATEGORY.mystery,
    description: 'A small museum to the founder. Velvet rope. Dim spotlights.',
    vibe: 'Please do not touch the artifacts. Please do not look directly at the founder.',
    defaultBuilt: false,
    tier: 3,
    isWork: false,
    defaultGrid: { w: 3, h: 1 },
    color: '#7a6a52',
    palette: { wall: PALETTE.wallDim, floor: PALETTE.carpetTeal, accent: PALETTE.accentAmber },
    props: [
      { id: 'founder-bust-pedestal', slot: 'mid', prompt: 'marble bust of stern man on dark wood pedestal' },
      { id: 'velvet-rope-stanchion', slot: 'fore', prompt: 'pair of brass stanchions with maroon velvet rope', count: 2 },
      { id: 'museum-vitrine', slot: 'back', prompt: 'glass museum display case on wood base, single artifact inside' },
      { id: 'spotlight-track', slot: 'ceil', prompt: 'ceiling track lighting with adjustable spotlights' },
      { id: 'plaque-engraved-brass', slot: 'back', prompt: 'small engraved brass plaque mounted to wall' },
    ],
  },
  'testing-floor': {
    id: 'testing-floor',
    name: 'Testing Floor',
    category: ROOM_CATEGORY.mystery,
    description: 'Bare. Clean. A single object in the middle. Do not be alarmed.',
    vibe: 'The goat is part of the test.',
    defaultBuilt: false,
    tier: 4,
    isWork: false,
    defaultGrid: { w: 3, h: 2 },
    color: '#d8d4c4',
    palette: { wall: PALETTE.ceilingTile, floor: PALETTE.linoleumGrey, accent: PALETTE.accentRed },
    props: [
      { id: 'unexplained-pedestal', slot: 'mid', prompt: 'small white plinth, single unmarked object resting on top' },
      { id: 'observation-window', slot: 'back', prompt: 'one-way observation mirror set into beige wall' },
      { id: 'fluorescent-panel', slot: 'ceil', prompt: 'recessed fluorescent ceiling light panel', count: 4 },
    ],
  },
  'executive-office': {
    id: 'executive-office',
    name: 'Executive Office',
    category: ROOM_CATEGORY.mystery,
    description: 'Big desk. Window with painted sky. One red object you cannot quite identify.',
    vibe: 'The view is not a view.',
    defaultBuilt: false,
    tier: 4,
    isWork: false,
    defaultGrid: { w: 2, h: 2 },
    color: '#7a5a4a',
    palette: { wall: PALETTE.wallDim, floor: PALETTE.carpetTeal, accent: PALETTE.accentRed },
    props: [
      { id: 'executive-desk-mahogany', slot: 'mid', prompt: 'large mahogany executive desk, leather inlay top, brass handles' },
      { id: 'executive-chair-leather', slot: 'mid', prompt: 'high-backed oxblood leather executive chair' },
      { id: 'bookshelf-builtin', slot: 'back', prompt: 'built-in dark wood bookshelf, leather-bound volumes' },
      { id: 'painted-sky-window', slot: 'back', prompt: 'rectangular wall panel painted to look like a sky, slightly off' },
      { id: 'red-object-unidentified', slot: 'mid', prompt: 'small unidentifiable red lacquered object on desk' },
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

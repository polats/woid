/**
 * Shared art-direction constants for Shelter rooms.
 *
 * All generated room props (and any future hand-authored assets) should
 * pull from this file so the shelter reads as a single coherent world
 * rather than a grab-bag of AI outputs. Inspirations: Severance (Lumon),
 * The Stanley Parable, mid-century corporate retro-futurism.
 *
 * Two levers do most of the work here:
 *   1. STYLE_PROMPT_PREFIX — prepended to every prop generation prompt,
 *      so TRELLIS / FLUX outputs land in the same visual register.
 *   2. PALETTE — referenced by ShelterStage3D when it builds the
 *      procedural shell, and surfaced in the build carousel.
 */

/** Prepended to every prop generation prompt. Keep terse — TRELLIS
 *  weights early tokens heavily. */
export const STYLE_PROMPT_PREFIX =
  '1980s corporate office prop, isolated on neutral white background, '
  + 'matte materials, beige and muted teal palette, fluorescent overhead lighting, '
  + 'subtle wear, photoreal but understated, no people, no text labels'

/** Negative prompt — things that break the aesthetic. */
export const STYLE_PROMPT_NEGATIVE =
  'saturated colors, neon, cyberpunk, fantasy, cartoon, anime, '
  + 'modern apple-style minimalism, glass skyscraper, cluttered, busy'

/** Core palette. Hex only; alpha handled at the render layer. */
export const PALETTE = {
  // Walls / shells
  wallWarm: '#d8cdb4',       // primary beige for most rooms
  wallCool: '#c8c8be',       // greyer beige for service rooms
  wallDim: '#9a8e76',        // archives, storage, mystery
  // Floors
  carpetTeal: '#5a7a72',     // Severance MDR carpet
  carpetBeige: '#a89878',    // common areas
  linoleumGrey: '#a8a8a0',   // restroom, mailroom
  // Trim / structural
  trimWood: '#6a4a32',       // dark wood baseboards, door frames
  ceilingTile: '#e8e4d8',    // off-white acoustic tile
  // Accents — use sparingly, one per room
  accentGreen: '#7aa884',    // CRT phosphor, MDR signage
  accentRed: '#a84a3a',      // boss/management cue
  accentAmber: '#c8a868',    // desk lamps, warning lights
}

/** Material hints for procedural geometry — keyed by surface role. */
export const MATERIALS = {
  wall: { roughness: 0.95, metalness: 0.0 },
  floor: { roughness: 0.85, metalness: 0.0 },
  ceiling: { roughness: 0.9, metalness: 0.0 },
  laminate: { roughness: 0.6, metalness: 0.05 },  // desks, counters
  metal: { roughness: 0.4, metalness: 0.7 },       // filing cabinets, chairs
  fabric: { roughness: 1.0, metalness: 0.0 },      // chair seats, partitions
  screen: { roughness: 0.2, metalness: 0.0, emissive: PALETTE.accentGreen },
}

/** Lighting recipe — flat fluorescent + per-room warm accent. Consumed
 *  by ShelterStage3D when building room interiors. */
export const LIGHTING = {
  fluorescent: { color: '#e8eef0', intensity: 0.55 },  // cool overhead
  deskLamp: { color: '#ffd8a0', intensity: 0.45 },     // warm point light
  crtGlow: { color: PALETTE.accentGreen, intensity: 0.25 },
}

/** Build a prop generation prompt by composing the prefix with
 *  per-prop detail. Keep `detail` short and concrete. */
export function buildPropPrompt(detail) {
  return `${STYLE_PROMPT_PREFIX}, ${detail}`
}

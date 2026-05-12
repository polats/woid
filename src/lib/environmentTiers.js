/**
 * Vertical tier definitions for the shelter's exterior backdrop.
 *
 * Each tier covers a band of `gridY` values; the BackgroundLayer paints
 * a horizontal plate behind the dollhouse cells for every tier and
 * positions it in world Y using `cellH × bandSpan`. With cells stacked
 * along `gridY`, the player's view of "what's outside" changes as they
 * build up or down.
 *
 * `gridYMax = 999` / `gridYMin = -999` mean "open at that end" — the
 * sky tier and the deep tier extend to infinity so panning never reveals
 * empty space past the last hand-authored band.
 *
 * Prompts are hand-curated (not LLM-generated) because the aesthetic of
 * the backdrop is the strongest signal the player gets for "where am I
 * in the building". Keeping them stable across rerolls is worth the
 * tradeoff of fewer creative surprises.
 */
export const ENVIRONMENT_TIERS = [
  {
    id: 'sky',
    gridYMin: 3,
    gridYMax: 999,
    aspectW: 2048,
    aspectH: 1024,
    // Pale overcast Lumon-winter sky. Cool blue-grey reads as outdoor
    // air vs. the warm beiges of the building cladding below.
    topHex: '#98a8ba',
    bottomHex: '#c5d2dc',
    fallbackHex: '#bccad6',
    prompt:
      'Wide pale overcast sky over a corporate park, distant beige '
      + 'office towers fading into haze, a single weather balloon. '
      + 'No sun. Severance / Lumon mood. Photorealistic, panoramic.',
  },
  {
    id: 'upper-floors',
    gridYMin: 2,
    gridYMax: 2,
    aspectW: 2048,
    aspectH: 768,
    // Warm building cladding still catching sky reflection at the top
    // of the facade.
    topHex: '#c8baa0',
    bottomHex: '#a89878',
    fallbackHex: '#c5b89a',
    prompt:
      'Wide exterior shot of the upper floors of a mid-rise corporate '
      + 'building, repeating identical office windows, beige stucco '
      + 'facade, distant air-conditioning units on the roofline. '
      + 'Overcast institutional light, panoramic.',
  },
  {
    id: 'mid-floors',
    gridYMin: 1,
    gridYMax: 1,
    aspectW: 2048,
    aspectH: 768,
    // Mid-rise cladding, closer to ground so cooler and slightly damper.
    topHex: '#a89878',
    bottomHex: '#8a7e6a',
    fallbackHex: '#a89878',
    prompt:
      'Wide exterior shot of the second floor of a corporate building, '
      + 'repeating identical office windows, ductwork and conduit along '
      + 'the wall, a single security camera. Beige stucco. Overcast '
      + 'institutional light, panoramic.',
  },
  {
    id: 'ground',
    gridYMin: 0,
    gridYMax: 0,
    aspectW: 2048,
    aspectH: 768,
    // Street-level plaza concrete — desaturated, slightly damp.
    topHex: '#7d7468',
    bottomHex: '#4e4842',
    fallbackHex: '#7d7468',
    prompt:
      'Wide panoramic cross-section of a sterile 1980s corporate plaza '
      + 'fronting a beige laminate building. Revolving glass entrance '
      + 'doors. Empty manicured concrete planters with low evergreen '
      + 'hedges. Overcast institutional sky. Depopulated, slightly '
      + 'fluorescent-tinted. Wide cinematic angle, head-on.',
  },
  {
    id: 'basement',
    gridYMin: -1,
    gridYMax: -1,
    aspectW: 2048,
    aspectH: 768,
    // Dim parking-garage concrete with a green-fluorescent cast.
    topHex: '#4a4e48',
    bottomHex: '#2d2f2c',
    fallbackHex: '#494e48',
    prompt:
      'Wide panoramic cross-section of a corporate parking garage, '
      + 'half-burnt fluorescent tubes, concrete pillars, oil stains, '
      + 'empty parking bays receding into shadow. Low ceiling. Dim '
      + 'and slightly damp.',
  },
  {
    id: 'archive',
    gridYMin: -2,
    gridYMax: -2,
    aspectW: 2048,
    aspectH: 768,
    // Severance archive olive — deeper green-brown, deader.
    topHex: '#3a3a2c',
    bottomHex: '#1e1e16',
    fallbackHex: '#3a3a2c',
    prompt:
      'Wide panoramic cross-section of a filing-cabinet maze, '
      + 'identical olive-green steel cabinets in long rows, drop-tile '
      + 'ceiling, fluorescent panels stretching into infinity, low '
      + 'pile carpet. Severance-style sterile. Photorealistic.',
  },
  {
    id: 'deep',
    gridYMin: -999,
    gridYMax: -3,
    aspectW: 2048,
    aspectH: 1024,
    // Backrooms mono-yellow — saturated, fluorescent-tinged. Keep the
    // gradient subtle so the contrast doesn't read as a hard edge.
    topHex: '#b89436',
    bottomHex: '#8a6c24',
    fallbackHex: '#a88a30',
    prompt:
      'Wide panoramic cross-section of the Backrooms — endless damp '
      + 'mono-yellow wallpaper, low-pile beige carpet, humming '
      + 'fluorescent lights, no end in sight. Liminal, depopulated, '
      + 'photorealistic.',
  },
]

/** Look up the tier that covers a given gridY value. */
export function tierForGridY(gridY) {
  for (const t of ENVIRONMENT_TIERS) {
    if (gridY >= t.gridYMin && gridY <= t.gridYMax) return t
  }
  return null
}

/** Aggregate the world-Y centre + height for a tier, given cellH. */
export function tierWorldBand(tier, cellH) {
  // Clamp the "open" bands to a finite render extent so the plate
  // mesh has a reasonable size — sky goes up ~10 cells past gridY 3,
  // deep goes down ~10 cells past gridY -3. The plate's z position
  // sits far enough back that the eye won't notice the cap.
  const min = tier.gridYMin <= -100 ? tier.gridYMax - 10 : tier.gridYMin
  const max = tier.gridYMax >= 100 ? tier.gridYMin + 10 : tier.gridYMax
  const bandSpan = (max - min + 1)
  const centreGridY = (min + max + 1) / 2
  return {
    worldY: centreGridY * cellH,
    worldH: bandSpan * cellH,
  }
}

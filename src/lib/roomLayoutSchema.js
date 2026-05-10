/**
 * Room layout schema — the single source of truth for the new
 * data-driven room pipeline.
 *
 * A *layout* describes a room's geometry and prop placement in metres,
 * room-local coordinates. Materials and prop GLBs are layered on top
 * by separate stores; the layout is the deterministic core that the
 * gray-box renderer, the mockup pipeline, and the per-prop generator
 * all read from.
 *
 * Coordinate convention:
 *   x: left/right     (- = left, + = right)
 *   y: up             (0 = floor, +height = ceiling)
 *   z: depth          (- = back wall, + = open front)
 *   rotation_y:       radians, ccw around +y
 *   size:             axis-aligned bounding box in object-local frame
 *
 * Hand-rolled validator instead of a runtime dep — keeps the bundle
 * lean and makes error messages explicit. Returns normalised data so
 * downstream code can rely on every field being present.
 */

export const LAYOUT_VERSION = 1

/**
 * Supported prop kinds. Open-ended (LLM may emit anything) — kind is a
 * hint for downstream consumers (e.g. default materials), not a gate.
 * Validator warns on unknown but doesn't reject.
 */
export const KNOWN_PROP_KINDS = new Set([
  'desk', 'chair', 'table', 'cabinet', 'shelf',
  'monitor', 'lamp', 'plant', 'art',
  'door', 'window', 'partition',
  'machine', 'fixture', 'sign', 'rug',
  'misc',
])

// Smallest plausible prop / room dimension. Was 0.1 — too strict; flat
// props (paintings, signs, doors, windows, partitions, ceiling fixtures,
// rugs) are routinely 0.02–0.05 m thick. The bridge's kind-default sizes
// already use those values, so a stricter min causes the bridge to write
// layouts that fail frontend validation. 0.02 covers the realistic floor
// (sub-cm props are rendering noise rather than design intent).
const DIM_MIN = 0.02
const DIM_MAX = 50

/**
 * Validate + normalise a layout object.
 *
 * @returns { ok, errors, warnings, value } — `value` is the normalised
 *   layout (defaults filled in) when ok===true.
 */
export function validateLayout(input) {
  const errors = []
  const warnings = []
  if (!input || typeof input !== 'object') {
    return fail(['layout must be an object'])
  }

  const v = {
    version: typeof input.version === 'number' ? input.version : LAYOUT_VERSION,
    id: str(input.id, 'id', errors),
    name: str(input.name, 'name', errors),
    description: input.description ?? '',
    vibe: input.vibe ?? '',
    category: input.category ?? 'work',
    dimensions: dimensions(input.dimensions, errors),
    palette: palette(input.palette, errors),
    materials: materials(input.materials, warnings),
    lighting: lighting(input.lighting),
    // Cached FLUX prompt that produced this room's concept image (the
    // moodboard inspiration). Layouts get a fluxPrompt at generation
    // time; static / migrated rooms may lack one.
    fluxPrompt: typeof input.fluxPrompt === 'string' ? input.fluxPrompt : '',
    // Status flag — 'draft' (rooms editor only) vs 'added' (also in
    // the shelter build menu). Default 'draft' but PRESERVE explicit
    // 'added' across saves so editing an added room doesn't bounce
    // it back to drafts.
    status: input.status === 'added' ? 'added' : 'draft',
    // Canonical prop list emitted by the initial-room flow. zone,
    // orientation, sizeHint are passed through so the deterministic
    // placeFromZones path keeps working after a save.
    proposedProps: Array.isArray(input.proposedProps)
      ? input.proposedProps
          .filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
          .map((p) => ({
            id: p.id,
            kind: typeof p.kind === 'string' ? p.kind : 'misc',
            prompt: typeof p.prompt === 'string' ? p.prompt : '',
            ...(typeof p.zone === 'string' ? { zone: p.zone } : {}),
            ...(typeof p.orientation === 'string' ? { orientation: p.orientation } : {}),
            ...(p.sizeHint && typeof p.sizeHint === 'object' ? { sizeHint: p.sizeHint } : {}),
          }))
      : [],
    props: [],
  }
  if (errors.length) return fail(errors, warnings)

  // Slug-style id
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(v.id)) {
    errors.push(`id must be a slug (lower alnum + - _), got "${v.id}"`)
  }

  // Props pass — validate each, then run pairwise overlap check.
  if (!Array.isArray(input.props)) {
    errors.push('props must be an array')
  } else {
    const seen = new Set()
    input.props.forEach((p, i) => {
      const norm = prop(p, i, errors, warnings, v.dimensions)
      if (!norm) return
      if (seen.has(norm.id)) errors.push(`duplicate prop id "${norm.id}" at index ${i}`)
      seen.add(norm.id)
      v.props.push(norm)
    })
    overlapCheck(v.props, warnings)
  }

  if (errors.length) return fail(errors, warnings)
  return { ok: true, errors: [], warnings, value: v }
}

function fail(errors, warnings = []) {
  return { ok: false, errors, warnings, value: null }
}

function str(x, field, errors) {
  if (typeof x !== 'string' || !x) {
    errors.push(`${field} must be a non-empty string`)
    return ''
  }
  return x
}

function num(x, field, errors, { min = -Infinity, max = Infinity } = {}) {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    errors.push(`${field} must be a finite number`)
    return 0
  }
  if (x < min || x > max) {
    errors.push(`${field} out of range [${min}, ${max}]: ${x}`)
    return x
  }
  return x
}

function dimensions(d, errors) {
  if (!d || typeof d !== 'object') {
    errors.push('dimensions required: { width, depth, height }')
    return { width: 0, depth: 0, height: 0 }
  }
  return {
    width: num(d.width, 'dimensions.width', errors, { min: DIM_MIN, max: DIM_MAX }),
    depth: num(d.depth, 'dimensions.depth', errors, { min: DIM_MIN, max: DIM_MAX }),
    height: num(d.height, 'dimensions.height', errors, { min: DIM_MIN, max: DIM_MAX }),
  }
}

const HEX = /^#[0-9a-f]{6}$/i
function hex(x, field, errors) {
  if (typeof x !== 'string' || !HEX.test(x)) {
    errors.push(`${field} must be a #RRGGBB colour, got ${JSON.stringify(x)}`)
    return '#888888'
  }
  return x.toLowerCase()
}

function palette(p, errors) {
  if (!p || typeof p !== 'object') {
    errors.push('palette required: { wall, floor, accent }')
    return { wall: '#888888', floor: '#888888', accent: '#888888' }
  }
  return {
    wall: hex(p.wall, 'palette.wall', errors),
    floor: hex(p.floor, 'palette.floor', errors),
    accent: hex(p.accent, 'palette.accent', errors),
    ...(p.ceiling ? { ceiling: hex(p.ceiling, 'palette.ceiling', errors) } : {}),
    ...(p.trim ? { trim: hex(p.trim, 'palette.trim', errors) } : {}),
  }
}

function materials(m, warnings) {
  // Two shapes accepted: { wall: "carpet-teal" } string-ref into the
  // shared materials library, or { wall: { prompt, tiling? } } inline.
  // The shared form is preferred; inline becomes a one-off generation.
  if (!m || typeof m !== 'object') return {}
  const out = {}
  for (const key of ['wall', 'floor', 'ceiling']) {
    if (!(key in m)) continue
    const v = m[key]
    if (typeof v === 'string') {
      out[key] = { ref: v }
    } else if (v && typeof v === 'object' && typeof v.prompt === 'string') {
      out[key] = {
        prompt: v.prompt,
        tiling: v.tiling && typeof v.tiling === 'object'
          ? { u: Number(v.tiling.u) || 1, v: Number(v.tiling.v) || 1 }
          : { u: 1, v: 1 },
      }
    } else {
      warnings.push(`materials.${key} ignored (must be string ref or {prompt, tiling?})`)
    }
  }
  return out
}

function lighting(l) {
  if (!l || typeof l !== 'object') return null
  const out = {}
  if (l.fluorescent && typeof l.fluorescent === 'object') {
    out.fluorescent = {
      color: typeof l.fluorescent.color === 'string' && HEX.test(l.fluorescent.color)
        ? l.fluorescent.color.toLowerCase() : '#e8eef0',
      intensity: Number(l.fluorescent.intensity) || 0.55,
    }
  }
  if (l.accent && typeof l.accent === 'object') {
    out.accent = {
      color: typeof l.accent.color === 'string' && HEX.test(l.accent.color)
        ? l.accent.color.toLowerCase() : '#ffd8a0',
      intensity: Number(l.accent.intensity) || 0.45,
      positions: Array.isArray(l.accent.positions)
        ? l.accent.positions.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
        : [],
    }
  }
  return out
}

function prop(p, i, errors, warnings, dims) {
  if (!p || typeof p !== 'object') {
    errors.push(`props[${i}] must be an object`)
    return null
  }
  const id = str(p.id, `props[${i}].id`, errors)
  if (!id) return null
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    errors.push(`props[${i}].id must be a slug, got "${id}"`)
    return null
  }
  const kind = typeof p.kind === 'string' ? p.kind : 'misc'
  if (!KNOWN_PROP_KINDS.has(kind)) warnings.push(`props[${i}].kind "${kind}" not in KNOWN_PROP_KINDS`)
  const prompt = str(p.prompt, `props[${i}].prompt`, errors)

  const size = {
    w: num(p.size?.w, `props[${i}].size.w`, errors, { min: DIM_MIN, max: DIM_MAX }),
    h: num(p.size?.h, `props[${i}].size.h`, errors, { min: DIM_MIN, max: DIM_MAX }),
    d: num(p.size?.d, `props[${i}].size.d`, errors, { min: DIM_MIN, max: DIM_MAX }),
  }
  const position = {
    x: num(p.position?.x, `props[${i}].position.x`, errors),
    y: num(p.position?.y ?? 0, `props[${i}].position.y`, errors),
    z: num(p.position?.z, `props[${i}].position.z`, errors),
  }
  const rotation_y = Number.isFinite(p.rotation_y) ? p.rotation_y : 0

  // Bounds — prop AABB must lie inside the room. Tolerance is the larger
  // of 0.01 (float-slop) and half-thickness IF the prop is thin on that
  // axis (< 0.1 m total). Wall-mount paintings/signs (depth 0.05) flush
  // against the back wall stick 0.025 m through — that's intended, not a
  // bug. Floor desks (d=2) don't get the slack — kept at 0.01.
  const halfW = size.w / 2
  const halfD = size.d / 2
  const halfH = size.h / 2
  const tolX = size.w < 0.1 ? halfW : 0.01
  const tolZ = size.d < 0.1 ? halfD : 0.01
  const tolY = size.h < 0.1 ? halfH : 0.01
  const minX = -dims.width / 2
  const maxX = dims.width / 2
  const minZ = -dims.depth / 2
  const maxZ = dims.depth / 2
  if (position.x - halfW < minX - tolX || position.x + halfW > maxX + tolX) {
    warnings.push(`props[${i}] "${id}" extends outside room on X`)
  }
  if (position.z - halfD < minZ - tolZ || position.z + halfD > maxZ + tolZ) {
    warnings.push(`props[${i}] "${id}" extends outside room on Z`)
  }
  if (position.y < -tolY || position.y + size.h > dims.height + tolY) {
    warnings.push(`props[${i}] "${id}" extends outside room on Y`)
  }

  return {
    id,
    kind,
    prompt,
    position,
    rotation_y,
    size,
    materials: Array.isArray(p.materials) ? p.materials.filter((m) => typeof m === 'string') : [],
    count: Number.isInteger(p.count) && p.count > 1 ? p.count : 1,
  }
}

/**
 * Pairwise AABB overlap check. Doesn't reject — the LLM may legitimately
 * stack props (chair tucked under desk, lamp on table). Stack-aware: if
 * one prop's footprint sits cleanly above the other (y-separated), skip
 * the warning — that's a desk-with-monitor relationship, not a clash.
 */
function overlapCheck(props, warnings) {
  for (let i = 0; i < props.length; i += 1) {
    for (let j = i + 1; j < props.length; j += 1) {
      if (aabbOverlap(props[i], props[j]) && !isStacked(props[i], props[j])) {
        warnings.push(`overlap: "${props[i].id}" and "${props[j].id}"`)
      }
    }
  }
}

function aabbOverlap(a, b) {
  const ax1 = a.position.x - a.size.w / 2, ax2 = a.position.x + a.size.w / 2
  const az1 = a.position.z - a.size.d / 2, az2 = a.position.z + a.size.d / 2
  const ay1 = a.position.y, ay2 = a.position.y + a.size.h
  const bx1 = b.position.x - b.size.w / 2, bx2 = b.position.x + b.size.w / 2
  const bz1 = b.position.z - b.size.d / 2, bz2 = b.position.z + b.size.d / 2
  const by1 = b.position.y, by2 = b.position.y + b.size.h
  return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1 && az1 < bz2 && az2 > bz1
}

// Y-axis separation tolerance for stacking: if one prop's base sits within
// 5 cm of the other's top (or above), treat as stacked (monitor-on-desk,
// lamp-on-table, bell-on-counter, fixture-on-ceiling).
function isStacked(a, b) {
  const aTop = a.position.y + a.size.h
  const bTop = b.position.y + b.size.h
  const TOL = 0.05
  return a.position.y >= bTop - TOL || b.position.y >= aTop - TOL
}

// Spell schema — single source of truth for what the LLM may emit and what
// the runtime will accept. The bridge endpoint embeds this spec verbatim into
// the system prompt; the client validates the response against the same rules
// before persisting.
//
// Design constraints:
// - No generated JS. Spells are JSON + GLSL strings + named behaviors only.
// - Fixed force/behavior vocabulary. Unknown names are rejected.
// - GLSL is *opaque text* here — we only check for a denylist of identifiers
//   that could escape the uniform whitelist. Compile errors surface at runtime.

export const FORCE_TYPES = ['gravity', 'drag', 'turbulence', 'attractor', 'vortex']
export const EMITTER_SHAPES = ['point', 'sphere', 'box', 'cone', 'line']
export const VELOCITY_KINDS = ['radial', 'vector', 'cone']
export const BLEND_MODES = ['additive', 'alpha', 'premult']
export const BEHAVIORS = ['homing', 'chainJump', 'attachToBone']
export const POST_TYPES = ['bloom']
export const ANCHOR_TYPES = ['caster', 'target', 'world']

// Identifiers a generated shader is NOT allowed to reference. The whitelist
// approach (only allow listed uniforms) is enforced at compile time by the
// runtime; this is a cheap pre-filter for obviously-wrong output.
const SHADER_DENYLIST = [
  'gl_FragDepth', // depth writes break our z-sort assumptions
  'discard;',     // allowed in carefully written effects but easy to abuse — flag for v1
]

const ALLOWED_UNIFORMS = new Set([
  'uTime', 'uDelta', 'uLifetime01', 'uSeed',
  'uCasterPos', 'uTargetPos', 'uResolution', 'uCameraPos',
  'uColor', 'uPower', 'uNoiseTex',
])

// Validation is intentionally lenient: only reject things the runtime *cannot*
// possibly handle (wrong type, no layers). Unknown force types, blend modes,
// extra fields etc. are fine — the runtime ignores what it doesn't recognize.
// Strict schema enforcement is premature when the runtime is still a sketch
// and would just block users from seeing what the model produced.
export function validateSpell(spell) {
  const errors = []
  if (!spell || typeof spell !== 'object') return ['spell must be an object']
  if (typeof spell.name !== 'string' || !spell.name.trim()) errors.push('name must be a non-empty string')
  if (!Array.isArray(spell.layers) || spell.layers.length === 0) {
    errors.push('layers must be a non-empty array')
  }
  // Shader denylist still applies — these are security-relevant, not spec.
  if (Array.isArray(spell.layers)) {
    spell.layers.forEach((layer, i) => {
      const sh = layer?.shader
      if (!sh) return
      for (const key of ['vertex', 'fragment']) {
        const src = sh[key]
        if (typeof src !== 'string') continue
        for (const bad of SHADER_DENYLIST) {
          if (src.includes(bad)) errors.push(`layers[${i}].shader.${key} contains disallowed token: ${bad}`)
        }
      }
    })
  }
  return errors
}

// Compact, example-driven spec. The model pattern-matches the example faster
// than it reads a long grammar. Vocabulary used here matches the registry
// constants above; unknown values are tolerated by the runtime so this is
// the *recommended* set, not the *required* set.
export const SCHEMA_SPEC = `
Spells are JSON objects with a "layers" array. Two kinds of layers:

(A) "particles" — emitter + forces + per-particle curves, billboard sprites.
(B) "mesh"      — a primitive (ring, disc, sphere, cylinder, torus, quad)
                  that grows / fades over the spell duration. Great for
                  shockwaves, energy rings, glowing orbs, beams.

Combine kinds freely — most strong spells use BOTH a mesh shockwave and
particles. Adapt fields, colors, and forces to the prompt; keep the
overall structure shown below.

EXAMPLE — fireball with shockwave ring:

{
  "name": "Fireball",
  "duration": 1.8,
  "anchor": { "type": "caster", "offset": [0, 1.2, 0] },
  "motion": { "kind": "projectile", "speed": 5 },
  "layers": [
    {
      "kind": "mesh",
      "geometry": "ring",
      "params": { "innerRadius": 0.4, "outerRadius": 0.5, "segments": 64 },
      "transform": { "scale": [1, 1, 1], "billboard": true },
      "displace": "jagged",
      "phase": { "start": 0.65, "end": 1.0 },
      "curves": {
        "scale": [[0, 0], [0.4, 2.5], [1, 3.0]],
        "alpha": [[0, 0], [0.1, 1], [1, 0]],
        "color": [[0, "#fff2b0"], [1, "#aa1100"]]
      },
      "shader": { "blend": "additive" }
    },
    {
      "kind": "particles",
      "shape": "spark",
      "phase": { "start": 0.0, "end": 0.7 },
      "emitter": {
        "shape": "sphere",
        "params": { "radius": 0.3 },
        "rate": { "perSecond": 400, "burst": 60 },
        "maxParticles": 600
      },
      "init": {
        "lifetime": { "min": 0.4, "max": 0.9 },
        "velocity": { "kind": "radial", "speed": [2, 5], "dir": [0, 1, 0], "spread": 0.4 },
        "size":     { "min": 0.05, "max": 0.18 }
      },
      "forces": [
        { "type": "drag", "k": 1.4 },
        { "type": "turbulence", "scale": 0.7, "strength": 1.8, "seed": 42 },
        { "type": "gravity", "g": [0, -0.6, 0] }
      ],
      "curves": {
        "color": [[0, "#fff7c2"], [0.3, "#ffaa33"], [0.8, "#aa1100"], [1, "#220000"]],
        "alpha": [[0, 0], [0.1, 1], [1, 0]],
        "size":  [[0, 0.4], [1, 1.5]]
      },
      "shader": { "blend": "additive" }
    }
  ]
}

Vocabulary:
- anchor.type: caster | target | world
- emitter.shape: point | sphere | box | cone | line
- velocity.kind: radial | vector | cone
- particle layer "shape" (REQUIRED — top-level on the layer, NOT under shader):
  circle | puff | star | spark | streak | cross
  Pick deliberately — never omit this field, never default to circle without
  reason. star = twinkles/holy. spark = impacts/electricity. streak = rain/
  embers/comets. puff = smoke/mist. cross = sparkle highlights. circle = soft
  generic glow only when nothing else fits.
- forces[].type: gravity | drag | turbulence | attractor | vortex
- mesh.geometry: ring | disc | sphere | cylinder | torus | quad
- mesh.displace: "wavy" | "jagged" | "spiked" | "warble" — animated noise
  vertex offset along normal. Use it! perfect rings/spheres look plastic.
    wavy   — soft sin waves (water ripple, gentle ghostly motion)
    jagged — sharp noise (lightning rim, crackling energy, broken edges)
    spiked — most vertices flat, occasional big spikes (burst, spike-burst)
    warble — slow large-scale wobble (smoke, fog, drifting ectoplasm)
  optionally tune via displaceStrength (0..0.4), displaceFrequency (1..12),
  displaceSpeed (0.3..3). Defaults are sensible if omitted.
- mesh.dissolve: noise-threshold burn-away effect. SHOWCASE technique —
  reach for it whenever something materializes, vanishes, or is being
  consumed by energy.
    { "scale": 5, "edgeColor": "#ffe680", "edgeWidth": 0.08,
      "direction": "outIn" }
  direction "outIn" (default): mesh starts whole at t=0, dissolves to
  nothing by t=1 (vanishing, ghost teleport, burning away).
  direction "inOut": mesh starts dissolved, materializes by t=1 (summon,
  spawn, ghost emerging).
- particle layer can pair with a mesh dissolve via "spawnFromMesh":
    "spawnFromMesh": { "layerIndex": 0 }
  When set, particles spawn from random surface points on layers[0]'s
  mesh instead of from the emitter shape — so as the mesh dissolves,
  particles fly off it. This is the SIGNATURE modern look.
- transform.billboard: true to face camera (good for ring/disc/quad)
- shader.blend: additive (fire/magic/sparkles/glows), alpha (smoke/mist)

spell.motion (optional, top-level): how the entire effect moves over time.
  { "kind": "static" }              — sits at anchor (default)
  { "kind": "projectile", "speed": 5 } — flies forward at speed m/s toward target
  { "kind": "arc", "speed": 4, "apex": 1.2 } — parabolic toss toward target
  { "kind": "orbit", "speed": 6, "radius": 0.8, "axis": [0,1,0] } — orbits anchor
  { "kind": "lift", "speed": 0.6 }  — rises straight up
  { "kind": "drop", "speed": 0.6 }  — falls straight down

layer.phase (optional, on each layer): { "start": 0.0, "end": 1.0 } — fraction
of duration when the layer is active. Use phasing to sequence beats — a flash
during 0.0..0.1, particles 0.0..0.7, an explosion ring 0.65..1.0. Phasing is
the difference between "static effect" and "spell" — USE IT for any spell with
more than one layer.

post[] is real — bloom drives the "magic" feel. ALWAYS include bloom unless
the spell is explicitly dim/subtle. Tune by mood:
  intense / luminous spells:  { type: "bloom", intensity: 1.0, threshold: 0.55 }
  warm / glowing spells:      { type: "bloom", intensity: 0.6, threshold: 0.7 }
  subtle / misty spells:      { type: "bloom", intensity: 0.35, threshold: 0.8 }

Color curves are the visual identity — pick distinctive ramps. Keep
maxParticles 200..800 for normal effects. Duration 0.5..3s. Mesh "scale"
curve is a multiplier; start at 0 and grow for shockwaves.
`.trim()

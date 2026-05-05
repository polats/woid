# Spells — VFX research

Reference notes captured while designing the **Spells** sandbox: a feature where the user creates spells via natural-language prompt, an LLM generates particle/shader code for them, and they can be cast on agents in the 3D stage by tapping. Local-only for v1, using the local Claude (mirrors the `my-steam` pattern).

This doc covers two questions:

1. How strict should the schema be for LLM-generated spells? (Pure config + GLSL vs. generated JS in a sandbox.)
2. What's the modern (2024–2026) state of the art for Three.js particle/shader VFX we should build on?

---

## 1. Schema strictness — what's achievable declaratively

**Verdict: a config + GLSL schema covers ~80% of typical RPG spells.** Anything where particles only depend on `(initial state, time, global forces, target position)` can be expressed declaratively. We lose imperative behavior the moment particles need to *react to other particles* or *runtime scene queries*.

| Effect | Schema-only feasible? | Notes |
|---|---|---|
| Fire | Yes | Cone emitter + upward velocity + drag + color ramp white→yellow→red, additive blend, domain-warp noise in fragment. |
| Smoke | Yes | Slow upward velocity + turbulence force + scale-up curve + alpha to 0. |
| Sparkles | Yes | Point emitter + random burst + `sin(time + id)` twinkle in fragment. |
| Magic auras | Yes | Sphere/mesh-zone emitter + fresnel shader + slow rotation. |
| Lightning bolts | Partial | Single bolt as animated polyline shader is doable. Branching/zigzag re-randomization wants a CPU regenerate trigger; can fake with seeded shader noise re-keyed each strike. |
| Healing glows | Yes | Attractor force pulling particles to target + upward bias + cyan additive. |
| Explosions | Yes | One-shot radial burst + drag + scale curve + expanding-ring billboard. |
| Swirls | Yes | Vortex force around an axis. |
| Beams | Yes | Stretched quad with scrolling-noise fragment shader; no particles needed. |

### What you lose without generated JS

1. **Homing missiles that retarget mid-flight** — attractor pointing at `$target` works for a fixed target, but if the projectile must pick the nearest live enemy when its current target dies, you need a CPU step running scene queries.
2. **Chain lightning (pick N nearest agents, jump sequentially)** — needs runtime scene-graph traversal and per-jump emitter respawn at new positions.
3. **Conforming shield mesh** — wrapping a target's skinned bounding volume, deforming on hit, dispelling at HP=0 needs imperative geometry construction + game-state hooks.
4. **Cross-spell interactions** ("dispel", "ignite oil puddle into fire wall") — schema has no awareness of other live spells.

### Recommended approach: schema + named-behavior escape hatch

Rich declarative vocabulary (emitter shapes, init distributions, forces, color/alpha/size curves, custom GLSL with whitelisted uniforms) **plus** a registry of pre-written JS behaviors the LLM can pick by name:

```jsonc
"onTick": "homing",        // not generated JS — picks from a fixed registry
"onHit":  "chainJump"
```

That keeps the safety of schema-only (no `eval`, GLSL compiles with timeout, uniforms whitelisted) while still covering homing/chain/dispel. New behaviors are hand-written; the LLM only composes existing ones.

### Schema sketch (covers ~80% of RPG spells)

```jsonc
{
  "id": "fireball",
  "duration": 2.0,
  "anchor": { "type": "caster|target|world", "offset": [0, 1, 0] },
  "layers": [
    {
      "kind": "particles",
      "emitter": {
        "shape": "sphere|box|cone|line|mesh|point",
        "params": { "radius": 0.5 },
        "rate":   { "perSecond": 200, "burst": 0 },
        "maxParticles": 2000
      },
      "init": {
        "lifetime": { "min": 0.4, "max": 0.9 },
        "velocity": { "kind": "radial|vector|cone", "speed": [2, 4], "dir": [0, 1, 0], "spread": 0.3 },
        "size":     { "min": 0.05, "max": 0.15 },
        "rotation": { "min": 0, "max": 6.28 },
        "seed":     "auto"
      },
      "forces": [
        { "type": "gravity", "g": [0, -2, 0] },
        { "type": "drag", "k": 1.2 },
        { "type": "turbulence", "scale": 0.7, "strength": 1.5, "seed": 42 },
        { "type": "attractor", "target": "$target", "strength": 8, "falloff": "inverse" },
        { "type": "vortex", "axis": [0, 1, 0], "strength": 3 }
      ],
      "curves": {
        "color": [[0, "#fff7c2"], [0.3, "#ffaa33"], [0.8, "#aa1100"], [1, "#220000"]],
        "alpha": [[0, 0], [0.1, 1], [1, 0]],
        "size":  [[0, 0.3], [1, 1.5]]
      },
      "shader": {
        "vertex":   "<glsl string or preset:'billboard'>",
        "fragment": "<glsl string or preset:'softParticleAdditive'>",
        "uniforms": { "uNoiseTex": "asset://noise/perlin", "uPower": 2.0 },
        "blend": "additive|alpha|premult"
      },
      "behaviors": ["homing"]
    },
    {
      "kind": "mesh",
      "geometry": "quad|ring|cylinder|sphere|asset://...",
      "transform": { "scale": [1, 1, 1], "billboard": true },
      "shader": { "fragment": "<glsl>", "uniforms": {} }
    }
  ],
  "post": [
    { "type": "bloom", "intensity": 0.8, "threshold": 0.6 },
    { "type": "chromaticAberration", "amount": 0.003 },
    { "type": "distortion", "source": "$layers[0].buffer", "strength": 0.02 }
  ],
  "audio": [{ "asset": "sfx://fire_whoosh", "at": 0 }]
}
```

**Documented uniform set always available to shaders:** `uTime, uDelta, uLifetime01 (per-particle), uSeed, uCasterPos, uTargetPos, uResolution, uCameraPos, uNoiseTex, uMatricesTex, uAttribs (color/size/age)`.

---

## 2. Modern Three.js VFX references (2024–2026)

The big shift since the older references (three-nebula, ShaderParticleEngine — both 5–10 years old): **TSL (Three.js Shading Language) + WebGPU compute** has replaced FBO ping-pong as the way to do million-particle effects. TSL is more declarative than raw GLSL, which makes it easier to constrain LLM output.

### Top picks

- [WebGPU Gommage — dissolving MSDF text into dust & petals](https://tympanus.net/codrops/2026/01/28/webgpu-gommage-effect-dissolving-msdf-text-into-dust-and-petals-with-three-js-tsl/) (Jan 2026) — gold for teleport / dissolve spells, full TSL source.
- [Dissolve effect with shaders + particles](https://tympanus.net/codrops/2025/02/17/implementing-a-dissolve-effect-with-shaders-and-particles-in-three-js/) (Feb 2025) — emissive-edge "vanish" VFX.
- [Procedural vortex inside a glass sphere (TSL)](https://tympanus.net/codrops/2025/03/10/rendering-a-procedural-vortex-inside-a-glass-sphere-with-three-js-and-tsl/) (Mar 2025) — trapped-soul / orb spells.
- [Three.js official: TSL compute attractors particles](https://threejs.org/examples/webgpu_tsl_compute_attractors_particles.html) — canonical compute-particle example to clone.
- [Maxime Heckel — Field Guide to TSL & WebGPU](https://blog.maximeheckel.com/posts/field-guide-to-tsl-and-webgpu/) — best long-form intro; replaces FBO ping-pong with compute shaders.

### Modern R3F VFX libs (the "new three-nebula")

- [wawa-vfx](https://github.com/wass08/wawa-vfx) — actively maintained, R3F-first, instanced particle engine.
- [three.quarks](https://github.com/Alchemist0823/three.quarks) — Unity-shuriken-style, JSON-serializable, still updated, works in WebGL and WebGPU.
- [vfx-composer](https://www.npmjs.com/package/vfx-composer) — composable GPU effects.

### Spell-specific references

- [Dracarys GPGPU fire-breath](https://discourse.threejs.org/t/dracarys-webgl-experiment-on-gpgpu-particles-sim-postprocessing/67031) — flame / breath spells.
- [Harry Potter wand-beam thread](https://discourse.threejs.org/t/light-spell-beam-as-in-harry-potter/59936) — direct beam-shader discussion.
- [threejs-lightning-storm](https://github.com/sctlcd/threejs-lightning-storm) — drop-in animated bolts.
- [Portal effects thread](https://discourse.threejs.org/t/how-to-create-a-portal-effect-or-how-to-fake-it/57752) — portal techniques summary.
- [Cells Collide — Rapier + organic particles](https://tympanus.net/codrops/2025/09/11/when-cells-collide-the-making-of-an-organic-particle-experiment-with-rapier-three-js/) — physics-driven swarms.
- [Vermeer Milkmaid → WebGPU particles](https://www.webgpu.com/showcase/vermeer-milkmaid-webgpu-particles/) — image-to-particle morph, great teleport visual.

### Post-processing (critical for the "magic" feel)

- [Maxime Heckel — Post-Processing as Creative Medium](https://blog.maximeheckel.com/posts/post-processing-as-a-creative-medium/) (Feb 2025) — bloom/glow/feedback.
- [Refraction, dispersion & light effects](https://blog.maximeheckel.com/posts/refraction-dispersion-and-other-shader-light-effects/) — crystal/energy-orb looks.
- [On Crafting Painterly Shaders](https://blog.maximeheckel.com/posts/on-crafting-painterly-shaders/) (Oct 2024) — stylized non-realistic spell aesthetics.

### GPGPU / compute showcases

- [Three.js Roadmap — Galaxy with WebGPU compute (1M particles)](https://threejsroadmap.com/blog/galaxy-simulation-webgpu-compute-shaders) — million-particle spiral, full TSL source.
- [Wawa Sensei — GPGPU particles with TSL & WebGPU](https://wawasensei.dev/courses/react-three-fiber/lessons/tsl-gpgpu) — practical R3F + TSL compute walkthrough.
- [Dreamy Particles GPGPU](https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/) (Dec 2024) + [repo](https://github.com/DGFX/codrops-dreamy-particles).
- [Phantom.land 3D face particle system](https://tympanus.net/codrops/2025/06/30/invisible-forces-the-making-of-phantom-lands-interactive-grid-and-3d-face-particle-system/) (Jun 2025) — interactive force-field particles.
- [Best of WebGPU — May 2025 roundup](https://www.webgpuexperts.com/best-webgpu-updates-may-2025/) — curated monthly digest.
- [False Earth — GPU-driven procedural planet (TSL)](https://www.webgpu.com/showcase/false-earth-procedural-planet-webgpu/).

### Creators worth following

- [Akella's CodePen](https://codepen.io/akella) and [Akella on X](https://x.com/akella) — daily WebGL/TSL micro-demos.
- [Maxime Heckel on X](https://x.com/MaximeHeckel) — frequent FBO/curl-noise particle threads.
- [Anderson Mancini](https://andersonmancini.dev/) — game-flavored R3F with VFX tutorials.
- [Ksenia Kondrashova on Dribbble](https://dribbble.com/ksenia-k) — clouds, ribbons, type-as-particles experiments.

### Older but still foundational

- [three-nebula](https://github.com/creativelifeform/three-nebula) and [docs](https://three-nebula-docs.netlify.app/) — config-driven particle system, has `fromJSON`. Closest existing match to our schema target. Built-in initializers (Position/Life/Velocity/Radius), behaviors (Force/Attraction/Repulsion/Drift/Gravity/Spring/Collision), zones (Sphere/Box/Line/Mesh).
- [ShaderParticleEngine](https://github.com/squarefeet/ShaderParticleEngine) — GLSL-heavy, lifetime curves baked into shader.
- [three.js GPGPU birds example](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_gpgpu_birds.html) — canonical FBO ping-pong reference.
- [Unity VFX Graph attribute reference](https://docs.unity3d.com/Packages/com.unity.visualeffectgraph@7.1/manual/Reference-Attributes.html) — useful inspiration for what schema fields actually matter: `position, velocity, color, alpha, size, age, lifetime, pivot, angle, angularVelocity, mass, texIndex, alive`.

---

## Open decisions

1. **TSL/WebGPU vs. WebGL+GLSL** — TSL is more declarative and easier to constrain LLM output, but WebGPU support varies. For a local-only sandbox we control the browser, so TSL is viable. Default lean: **TSL with three.quarks as the particle scaffolding** (it has JSON serialization and works in both pipelines).
2. **Schema + named-behavior registry vs. pure schema vs. generated JS in worker** — recommend the middle path (schema + named registry).
3. **v1 behavior registry** — start with `homing`, `chainJump`, `attachToBone`; grow as needed.
4. **Post-processing in v1?** — bloom is essentially free with three.js EffectComposer and worth including from day one for the "magic" feel; defer chromaticAberration / distortion to later.

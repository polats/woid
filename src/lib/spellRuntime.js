// Runtime for casting a spell schema in a Three.js scene.
//
//   const handle = castSpell(scene, spell, { position: vec3, target?: vec3 })
//   handle.tick(deltaSeconds) → boolean (true while alive)
//   handle.dispose()
//
// CPU-driven particle simulation; suitable for the schema's typical
// 200..800 particle range. Each layer becomes one THREE.Points mesh with a
// soft-additive billboard shader; per-particle color/alpha/size are computed
// from lifetime curves on the CPU and pushed to per-vertex attributes.
//
// Layer kinds:
//   - particles — emitter + forces + curves, billboard sprites
//   - mesh      — primitive geometry (quad|ring|disc|cylinder|sphere|torus)
//                 with optional billboard, curve-driven scale/alpha/color,
//                 and a soft-glow shader preset
//
// Ignored in v1: behaviors (homing/chainJump/attachToBone), post[], custom GLSL.

import * as THREE from 'three'

export function castSpell(scene, spell, anchor = { position: new THREE.Vector3() }) {
  const duration = clamp(Number(spell?.duration) || 1.5, 0.1, 10)
  const layers = []
  for (const layerDef of spell?.layers ?? []) {
    if (layerDef?.kind === 'particles') layers.push(new ParticleLayer(layerDef, anchor))
    else if (layerDef?.kind === 'mesh')  layers.push(new MeshLayer(layerDef, anchor, duration))
  }
  // Second pass: layers can reference each other (e.g. particle layer that
  // spawns from another mesh layer's surface). linkLayers runs after every
  // layer is constructed so cross-references resolve safely.
  for (const l of layers) l.linkLayers?.(layers)
  for (const l of layers) scene.add(l.mesh)

  let elapsed = 0
  let stopped = false

  // Anchor motion — spell-level. Runtime advances anchor.position each tick.
  // The base position is read from anchor.basePosition if present; otherwise
  // we snapshot anchor.position at cast time. Callers that want the spell
  // to follow a moving subject (e.g. an agent walking across the stage)
  // should overwrite anchor.basePosition each frame before tick().
  const motionDef = spell?.motion || { kind: 'static' }
  if (!anchor.basePosition) anchor.basePosition = anchor.position.clone()
  const targetVec = anchor.target ? anchor.target.clone() : null

  return {
    duration,
    tick(dt, ctx) {
      if (stopped) return false
      elapsed += dt
      const emitting = elapsed < duration
      const t01 = clamp(elapsed / duration, 0, 1)
      applyMotion(anchor, anchor.basePosition, targetVec, motionDef, elapsed, t01)
      for (const l of layers) l.update(dt, emitting, t01, elapsed, ctx)
      const allDead = !emitting && layers.every((l) => l.isDead?.() ?? l.aliveCount === 0)
      if (allDead) return false
      return true
    },
    dispose() {
      stopped = true
      for (const l of layers) {
        scene.remove(l.mesh)
        l.dispose()
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Particle layer
// ─────────────────────────────────────────────────────────────────────────

class ParticleLayer {
  constructor(def, anchor) {
    this.def = def
    this.anchor = anchor
    const max = clamp(Math.floor(def?.emitter?.maxParticles ?? 400), 1, 5000)
    this.max = max
    this.aliveCount = 0
    this.spawnAccumulator = 0
    this.didBurst = false
    // Phasing — when this layer is allowed to emit, expressed as fractions
    // of spell duration. Existing particles continue past phaseEnd; we just
    // stop spawning new ones.
    this.phaseStart = clamp(Number(def?.phase?.start ?? 0), 0, 1)
    this.phaseEnd   = clamp(Number(def?.phase?.end ?? 1), this.phaseStart, 1)
    // Optional: spawn particles from another mesh layer's surface (dissolve
    // effect). Resolved in linkLayers() once all layers are constructed.
    this.spawnFromMeshIndex = Number.isFinite(def?.spawnFromMesh?.layerIndex)
      ? def.spawnFromMesh.layerIndex : null
    this.surfacePoints = null
    this.surfaceMesh = null

    // Plain JS arrays of length `max` — simple and fast enough.
    this.positions = new Float32Array(max * 3)
    this.velocities = new Float32Array(max * 3)
    this.colors = new Float32Array(max * 3)
    this.alphas = new Float32Array(max)
    this.sizes = new Float32Array(max)      // current size = base * sizeCurve(t)
    this.baseSizes = new Float32Array(max)  // immutable spawn-time base
    this.ages = new Float32Array(max)
    this.lifetimes = new Float32Array(max)
    this.alive = new Uint8Array(max)
    this.seeds = new Float32Array(max)

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3))
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1))
    geometry.setDrawRange(0, 0)

    const blend = def?.shader?.blend
    const shape = SHAPE_IDS[def?.shape] ?? SHAPE_IDS.circle
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: blend === 'alpha' ? THREE.NormalBlending : THREE.AdditiveBlending,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPixelScale: { value: 800 },
        uShape: { value: shape },
      },
    })

    this.mesh = new THREE.Points(geometry, this.material)
    this.mesh.frustumCulled = false

    // Pre-bake the color/alpha/size curves for fast lookup.
    this.colorCurve = parseColorCurve(def?.curves?.color)
    this.alphaCurve = parseScalarCurve(def?.curves?.alpha, 1)
    this.sizeCurve = parseScalarCurve(def?.curves?.size, 1)
  }

  spawnOne() {
    if (this.aliveCount >= this.max) return -1
    // Find first dead slot.
    let idx = -1
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) { idx = i; break }
    }
    if (idx < 0) return -1

    const def = this.def
    const e = def.emitter || {}
    const init = def.init || {}
    const lifetime = sampleRange(init.lifetime, 0.5, 1.0)
    const baseSize = sampleRange(init.size, 0.05, 0.15)

    // Position: either sampled from another mesh's surface (dissolve) or
    // from the emitter shape, then translated by the anchor.
    if (this.surfacePoints && this.surfaceMesh) {
      const count = this.surfacePoints.length / 3
      const i3 = Math.floor(Math.random() * count) * 3
      _tmpV1.set(this.surfacePoints[i3], this.surfacePoints[i3 + 1], this.surfacePoints[i3 + 2])
      // Apply the source mesh's world transform — this is critical: the mesh
      // may be scaled by curves and translated to anchor.position.
      this.surfaceMesh.updateMatrixWorld()
      _tmpV1.applyMatrix4(this.surfaceMesh.matrixWorld)
      this.positions[idx * 3 + 0] = _tmpV1.x
      this.positions[idx * 3 + 1] = _tmpV1.y
      this.positions[idx * 3 + 2] = _tmpV1.z
    } else {
      const p = sampleEmitterPos(e, _tmpV1)
      p.add(this.anchor.position)
      this.positions[idx * 3 + 0] = p.x
      this.positions[idx * 3 + 1] = p.y
      this.positions[idx * 3 + 2] = p.z
    }

    // Velocity.
    const v = sampleVelocity(init.velocity, _tmpV2)
    this.velocities[idx * 3 + 0] = v.x
    this.velocities[idx * 3 + 1] = v.y
    this.velocities[idx * 3 + 2] = v.z

    this.lifetimes[idx] = lifetime
    this.ages[idx] = 0
    this.baseSizes[idx] = baseSize
    this.sizes[idx] = baseSize
    this.alphas[idx] = 1
    this.colors[idx * 3 + 0] = 1
    this.colors[idx * 3 + 1] = 1
    this.colors[idx * 3 + 2] = 1
    this.seeds[idx] = Math.random() * 1000
    this.alive[idx] = 1
    this.aliveCount++
    return idx
  }

  // Resolve cross-layer references after all layers in the spell are built.
  // Currently used by the dissolve effect to spawn particles from a mesh's
  // surface instead of the emitter shape.
  linkLayers(allLayers) {
    if (this.spawnFromMeshIndex == null) return
    const src = allLayers[this.spawnFromMeshIndex]
    if (!src || !(src instanceof MeshLayer)) return
    const posAttr = src.mesh.geometry?.attributes?.position
    if (!posAttr) return
    // Copy out a flat Float32Array of object-space vertex positions. The
    // mesh's matrixWorld transforms these into world space at spawn time.
    this.surfacePoints = new Float32Array(posAttr.array.length)
    this.surfacePoints.set(posAttr.array)
    this.surfaceMesh = src.mesh
  }

  isDead() { return this.aliveCount === 0 }

  update(dt, emitting, t01, _elapsed, _ctx) {
    const def = this.def
    const rate = def.emitter?.rate || {}
    // Layer-local emission gate: respect both spell duration AND the layer's
    // phase window. didBurst guards on entering the window for the first time.
    const inPhase = t01 >= this.phaseStart && t01 < this.phaseEnd
    const layerEmitting = emitting && inPhase

    // Burst on first frame of life within phase window.
    if (layerEmitting && !this.didBurst) {
      const burst = Math.max(0, Math.floor(rate.burst ?? 0))
      for (let i = 0; i < burst; i++) this.spawnOne()
      this.didBurst = true
    }
    // Continuous spawning — only while in phase window.
    if (layerEmitting) {
      const perSecond = Math.max(0, Number(rate.perSecond) || 0)
      this.spawnAccumulator += perSecond * dt
      while (this.spawnAccumulator >= 1) {
        this.spawnAccumulator -= 1
        if (this.spawnOne() < 0) break
      }
    }

    // Force vector reused per particle.
    const forces = Array.isArray(def.forces) ? def.forces : []
    const baseSizeCurve = this.sizeCurve
    const alphaCurve = this.alphaCurve
    const colorCurve = this.colorCurve

    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue
      this.ages[i] += dt
      const t = this.ages[i] / this.lifetimes[i]
      if (t >= 1) {
        this.alive[i] = 0
        this.aliveCount--
        this.alphas[i] = 0
        this.sizes[i] = 0
        continue
      }

      // Apply forces to velocity.
      let ax = 0, ay = 0, az = 0
      const px = this.positions[i * 3 + 0]
      const py = this.positions[i * 3 + 1]
      const pz = this.positions[i * 3 + 2]
      let vx = this.velocities[i * 3 + 0]
      let vy = this.velocities[i * 3 + 1]
      let vz = this.velocities[i * 3 + 2]

      for (const f of forces) {
        const type = f?.type
        if (type === 'gravity') {
          const g = f.g || [0, -9.8, 0]
          ax += g[0] || 0; ay += g[1] || 0; az += g[2] || 0
        } else if (type === 'drag') {
          const k = Number(f.k) || 1
          ax -= vx * k; ay -= vy * k; az -= vz * k
        } else if (type === 'turbulence') {
          const scale = Number(f.scale) || 1
          const strength = Number(f.strength) || 1
          const seed = Number(f.seed) || 0
          const sx = px * scale, sy = py * scale, sz = pz * scale
          // Sample the same noise field at three offset lattices so each
          // axis gets a decorrelated value — pseudo-curl with flowing organic
          // motion instead of stiff oscillation.
          ax += noise3(sx + seed,        sy,              sz             ) * strength
          ay += noise3(sx,               sy + seed + 31,  sz             ) * strength
          az += noise3(sx,               sy,              sz + seed + 71 ) * strength
        } else if (type === 'attractor') {
          const target = resolveTargetPos(f.target, this.anchor) || this.anchor.position
          const dx = target.x - px, dy = target.y - py, dz = target.z - pz
          const dist2 = dx * dx + dy * dy + dz * dz + 0.01
          const strength = Number(f.strength) || 1
          const inv = f.falloff === 'linear' ? 1 / Math.sqrt(dist2) : 1 / dist2
          ax += dx * strength * inv
          ay += dy * strength * inv
          az += dz * strength * inv
        } else if (type === 'vortex') {
          const axis = f.axis || [0, 1, 0]
          const strength = Number(f.strength) || 1
          // Cross product (pos - anchor) × axis, normalized-ish.
          const rx = px - this.anchor.position.x
          const ry = py - this.anchor.position.y
          const rz = pz - this.anchor.position.z
          ax += (axis[1] * rz - axis[2] * ry) * strength
          ay += (axis[2] * rx - axis[0] * rz) * strength
          az += (axis[0] * ry - axis[1] * rx) * strength
        }
      }

      // Integrate.
      vx += ax * dt; vy += ay * dt; vz += az * dt
      this.velocities[i * 3 + 0] = vx
      this.velocities[i * 3 + 1] = vy
      this.velocities[i * 3 + 2] = vz
      this.positions[i * 3 + 0] = px + vx * dt
      this.positions[i * 3 + 1] = py + vy * dt
      this.positions[i * 3 + 2] = pz + vz * dt

      this.sizes[i] = this.baseSizes[i] * sampleCurve(baseSizeCurve, t)
      this.alphas[i] = sampleCurve(alphaCurve, t)
      const c = sampleColorCurve(colorCurve, t)
      this.colors[i * 3 + 0] = c.r
      this.colors[i * 3 + 1] = c.g
      this.colors[i * 3 + 2] = c.b
    }

    // Update geometry.
    const geom = this.mesh.geometry
    geom.setDrawRange(0, this.max)
    geom.attributes.position.needsUpdate = true
    geom.attributes.aColor.needsUpdate = true
    geom.attributes.aAlpha.needsUpdate = true
    geom.attributes.aSize.needsUpdate = true
    geom.computeBoundingSphere()
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mesh layer — single primitive that grows / fades over the spell duration.
// Useful for shockwaves, energy rings, glowing orbs, beams, etc.
// ─────────────────────────────────────────────────────────────────────────

class MeshLayer {
  constructor(def, anchor, duration) {
    this.def = def
    this.anchor = anchor
    this.duration = duration
    this.dead = false
    this.phaseStart = clamp(Number(def?.phase?.start ?? 0), 0, 1)
    this.phaseEnd   = clamp(Number(def?.phase?.end ?? 1), this.phaseStart, 1)

    const geom = makeMeshGeometry(def.geometry || 'ring', def.params || {})
    const blend = def?.shader?.blend
    const baseScale = def?.transform?.scale ?? [1, 1, 1]
    this.baseScale = Array.isArray(baseScale) ? baseScale : [baseScale, baseScale, baseScale]
    this.billboard = !!def?.transform?.billboard

    this.colorCurve = parseColorCurve(def?.curves?.color)
    this.alphaCurve = parseScalarCurve(def?.curves?.alpha, 1)
    this.scaleCurve = parseScalarCurve(def?.curves?.scale ?? def?.curves?.size, 1)

    // Dissolve — fragment-shader noise threshold that sweeps over the spell.
    // direction "outIn" (default): threshold rises 0→1, mesh fades away.
    // direction "inOut": threshold falls 1→0, mesh materializes from nothing.
    const dis = def?.dissolve
    this.hasDissolve = !!dis
    this.dissolveDir = dis?.direction === 'inOut' ? 'inOut' : 'outIn'
    this.dissolveEdgeColor = new THREE.Color(dis?.edgeColor ?? '#ffe680')
    this.dissolveScale = Number(dis?.scale ?? 5)
    this.dissolveEdgeWidth = Number(dis?.edgeWidth ?? 0.08)

    // Vertex displacement: turn perfect rings/spheres into something less
    // plasticky. Modes are pre-baked combinations of frequency/amplitude;
    // selected by string so the LLM doesn't have to fiddle with magic numbers.
    const displaceMode = DISPLACE_MODES[def.displace] ?? DISPLACE_MODES.none
    const displace = {
      mode:      { value: displaceMode.mode },
      strength:  { value: Number(def.displaceStrength ?? displaceMode.strength) },
      frequency: { value: Number(def.displaceFrequency ?? displaceMode.frequency) },
      speed:     { value: Number(def.displaceSpeed ?? displaceMode.speed) },
    }

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: blend === 'alpha' ? THREE.NormalBlending : THREE.AdditiveBlending,
      vertexShader: MESH_VERT,
      fragmentShader: MESH_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(1, 1, 1) },
        uAlpha: { value: 1 },
        uTime:  { value: 0 },
        uLifetime01: { value: 0 },
        uDisplaceMode:      displace.mode,
        uDisplaceStrength:  displace.strength,
        uDisplaceFrequency: displace.frequency,
        uDisplaceSpeed:     displace.speed,
        uDissolveOn:        { value: this.hasDissolve ? 1 : 0 },
        uDissolveThreshold: { value: 0 },
        uDissolveScale:     { value: this.dissolveScale },
        uDissolveEdgeWidth: { value: this.dissolveEdgeWidth },
        uDissolveEdgeColor: { value: this.dissolveEdgeColor.clone() },
      },
    })

    this.mesh = new THREE.Mesh(geom, this.material)
    const off = def?.anchor?.offset ?? def?.transform?.offset
    this.offset = Array.isArray(off) ? new THREE.Vector3(off[0] || 0, off[1] || 0, off[2] || 0)
                                     : new THREE.Vector3()
    this.mesh.position.copy(this.anchor.position).add(this.offset)
    this.mesh.scale.set(this.baseScale[0], this.baseScale[1], this.baseScale[2])
  }

  update(dt, _emitting, t01, elapsed, ctx) {
    // Hide outside phase window. Particles can persist across phase exits;
    // meshes are single objects so we just toggle visibility.
    const inPhase = t01 >= this.phaseStart && t01 <= this.phaseEnd
    this.mesh.visible = inPhase
    if (!inPhase) {
      if (t01 > this.phaseEnd) this.dead = true
      return
    }
    // Map global t01 to local [0..1] within the phase window so curves play
    // their full shape regardless of where the layer sits in the spell.
    const localT = (t01 - this.phaseStart) / Math.max(1e-6, this.phaseEnd - this.phaseStart)

    const s = sampleCurve(this.scaleCurve, localT)
    this.mesh.scale.set(this.baseScale[0] * s, this.baseScale[1] * s, this.baseScale[2] * s)
    this.material.uniforms.uColor.value.copy(sampleColorCurve(this.colorCurve, localT))
    this.material.uniforms.uAlpha.value = sampleCurve(this.alphaCurve, localT)
    this.material.uniforms.uTime.value = elapsed
    this.material.uniforms.uLifetime01.value = localT
    if (this.hasDissolve) {
      // outIn: 0→1 (visible → gone). inOut: 1→0 (gone → visible).
      this.material.uniforms.uDissolveThreshold.value =
        this.dissolveDir === 'inOut' ? (1 - localT) : localT
    }
    this.mesh.position.copy(this.anchor.position).add(this.offset)
    if (this.billboard && ctx?.camera) {
      this.mesh.lookAt(ctx.camera.position)
    }
    if (t01 >= 1) this.dead = true
  }

  isDead() { return this.dead }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

function makeMeshGeometry(kind, p = {}) {
  switch (kind) {
    case 'quad':
      return new THREE.PlaneGeometry(p.size ?? 1, p.size ?? 1)
    case 'disc':
      return new THREE.CircleGeometry(p.radius ?? 0.5, p.segments ?? 48)
    case 'ring':
      return new THREE.RingGeometry(
        p.innerRadius ?? 0.4,
        p.outerRadius ?? 0.5,
        p.segments ?? 64,
      )
    case 'cylinder':
      return new THREE.CylinderGeometry(
        p.radiusTop ?? 0.2,
        p.radiusBottom ?? 0.2,
        p.height ?? 1,
        p.segments ?? 32,
        1,
        true,
      )
    case 'sphere':
      return new THREE.SphereGeometry(p.radius ?? 0.4, p.widthSegments ?? 32, p.heightSegments ?? 16)
    case 'torus':
      return new THREE.TorusGeometry(p.radius ?? 0.5, p.tube ?? 0.05, p.radialSegments ?? 16, p.tubularSegments ?? 64)
    default:
      return new THREE.RingGeometry(0.4, 0.5, 64)
  }
}

// Displacement mode presets. mode is an int the vertex shader switches on:
//   0 none, 1 wavy (smooth low-freq sin), 2 jagged (high-freq value noise),
//   3 spiked (sharpened threshold), 4 warble (slow large-scale wobble).
const DISPLACE_MODES = {
  none:    { mode: 0, strength: 0,    frequency: 0,   speed: 0 },
  wavy:    { mode: 1, strength: 0.08, frequency: 4,   speed: 1.6 },
  jagged:  { mode: 2, strength: 0.12, frequency: 9,   speed: 2.0 },
  spiked:  { mode: 3, strength: 0.25, frequency: 7,   speed: 1.0 },
  warble:  { mode: 4, strength: 0.18, frequency: 1.8, speed: 0.7 },
}

const NOISE_GLSL = /* glsl */`
  // Cheap hash-based 3D value noise. Not the highest quality but fast and
  // visually adequate for vertex displacement.
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // smoothstep
    float n000 = hash3(i + vec3(0,0,0));
    float n100 = hash3(i + vec3(1,0,0));
    float n010 = hash3(i + vec3(0,1,0));
    float n110 = hash3(i + vec3(1,1,0));
    float n001 = hash3(i + vec3(0,0,1));
    float n101 = hash3(i + vec3(1,0,1));
    float n011 = hash3(i + vec3(0,1,1));
    float n111 = hash3(i + vec3(1,1,1));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    ) * 2.0 - 1.0;
  }
`

const MESH_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vObjPos;
  uniform float uTime;
  uniform int   uDisplaceMode;
  uniform float uDisplaceStrength;
  uniform float uDisplaceFrequency;
  uniform float uDisplaceSpeed;
  ${NOISE_GLSL}

  float displace(vec3 p, vec3 n) {
    float t = uTime * uDisplaceSpeed;
    if (uDisplaceMode == 1) {
      // wavy — smooth low-freq sin along arbitrary axis
      return sin(p.x * uDisplaceFrequency + t)
           * cos(p.y * uDisplaceFrequency * 0.7 + t * 1.3)
           * 0.5;
    } else if (uDisplaceMode == 2) {
      // jagged — high-freq noise
      return vnoise(p * uDisplaceFrequency + t);
    } else if (uDisplaceMode == 3) {
      // spiked — sharpened threshold of noise (most vertices flat, some big spikes)
      float n = vnoise(p * uDisplaceFrequency + t);
      return pow(max(0.0, n), 4.0) * 2.5;
    } else if (uDisplaceMode == 4) {
      // warble — slow wobble + tiny detail
      return vnoise(p * uDisplaceFrequency + t) * 0.7
           + vnoise(p * uDisplaceFrequency * 4.0 + t * 1.4) * 0.15;
    }
    return 0.0;
  }

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vObjPos = position;
    vec3 displaced = position + normal * displace(position, normal) * uDisplaceStrength;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`

// Soft-glow default plus optional dissolve. With dissolve on, fragments below
// the noise threshold are discarded and a glowing edge band sits at the wave
// front so the surface looks like it's burning away.
const MESH_FRAG = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vObjPos;
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform int   uDissolveOn;
  uniform float uDissolveThreshold;
  uniform float uDissolveScale;
  uniform float uDissolveEdgeWidth;
  uniform vec3  uDissolveEdgeColor;
  ${NOISE_GLSL}

  void main() {
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    float radial = 1.0 - smoothstep(0.0, 1.0, r);
    float fresnel = pow(1.0 - abs(vNormal.z), 1.5);
    float a = max(radial, fresnel);
    vec3  baseColor = uColor;

    if (uDissolveOn == 1) {
      // Sample noise in object space so the pattern is stable on the mesh.
      // 0.5+0.5*vnoise to remap [-1,1] → [0,1].
      float n = vnoise(vObjPos * uDissolveScale) * 0.5 + 0.5;
      // Discard fragments below threshold (dissolved away).
      if (n < uDissolveThreshold) discard;
      // Edge band: brighten + tint near the threshold for a "burn" rim.
      float edge = smoothstep(uDissolveThreshold + uDissolveEdgeWidth,
                              uDissolveThreshold,
                              n);
      baseColor = mix(uColor, uDissolveEdgeColor, edge);
      a = mix(a, max(a, edge), edge);
    }

    gl_FragColor = vec4(baseColor * a, a * uAlpha);
  }
`

// ─────────────────────────────────────────────────────────────────────────
// Curve helpers
// ─────────────────────────────────────────────────────────────────────────

function parseColorCurve(curve) {
  if (!Array.isArray(curve) || curve.length === 0) {
    return [[0, new THREE.Color(0xffffff)], [1, new THREE.Color(0xffffff)]]
  }
  const out = []
  for (const stop of curve) {
    if (!Array.isArray(stop) || stop.length < 2) continue
    const t = clamp(Number(stop[0]) || 0, 0, 1)
    const c = new THREE.Color(stop[1])
    out.push([t, c])
  }
  if (!out.length) return [[0, new THREE.Color(0xffffff)], [1, new THREE.Color(0xffffff)]]
  out.sort((a, b) => a[0] - b[0])
  return out
}

function parseScalarCurve(curve, def) {
  if (!Array.isArray(curve) || curve.length === 0) return [[0, def], [1, def]]
  const out = []
  for (const stop of curve) {
    if (!Array.isArray(stop) || stop.length < 2) continue
    const t = clamp(Number(stop[0]) || 0, 0, 1)
    const v = Number(stop[1])
    if (Number.isFinite(v)) out.push([t, v])
  }
  if (!out.length) return [[0, def], [1, def]]
  out.sort((a, b) => a[0] - b[0])
  return out
}

function sampleCurve(curve, t) {
  if (t <= curve[0][0]) return curve[0][1]
  if (t >= curve[curve.length - 1][0]) return curve[curve.length - 1][1]
  for (let i = 1; i < curve.length; i++) {
    const [t1, v1] = curve[i]
    const [t0, v0] = curve[i - 1]
    if (t <= t1) {
      const f = (t - t0) / Math.max(1e-6, t1 - t0)
      return v0 + (v1 - v0) * f
    }
  }
  return curve[curve.length - 1][1]
}

const _tmpColor = new THREE.Color()
function sampleColorCurve(curve, t) {
  if (t <= curve[0][0]) return curve[0][1]
  if (t >= curve[curve.length - 1][0]) return curve[curve.length - 1][1]
  for (let i = 1; i < curve.length; i++) {
    const [t1, c1] = curve[i]
    const [t0, c0] = curve[i - 1]
    if (t <= t1) {
      const f = (t - t0) / Math.max(1e-6, t1 - t0)
      _tmpColor.copy(c0).lerp(c1, f)
      return _tmpColor
    }
  }
  return curve[curve.length - 1][1]
}

// ─────────────────────────────────────────────────────────────────────────
// Sampling helpers
// ─────────────────────────────────────────────────────────────────────────

const _tmpV1 = new THREE.Vector3()
const _tmpV2 = new THREE.Vector3()

function sampleRange(rng, defMin, defMax) {
  if (Array.isArray(rng) && rng.length >= 2) {
    return rng[0] + Math.random() * (rng[1] - rng[0])
  }
  if (rng && typeof rng === 'object') {
    const min = Number(rng.min ?? defMin)
    const max = Number(rng.max ?? defMax)
    return min + Math.random() * (max - min)
  }
  if (typeof rng === 'number') return rng
  return defMin + Math.random() * (defMax - defMin)
}

function sampleEmitterPos(e, out) {
  const shape = e?.shape || 'point'
  const params = e?.params || {}
  if (shape === 'sphere') {
    const r = (Number(params.radius) || 0.3) * Math.cbrt(Math.random())
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    out.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
  } else if (shape === 'box') {
    const s = params.size || [0.4, 0.4, 0.4]
    out.set((Math.random() - 0.5) * s[0], (Math.random() - 0.5) * s[1], (Math.random() - 0.5) * s[2])
  } else if (shape === 'cone') {
    const angle = Number(params.angle) || 0.5
    const r = Math.random() * (Number(params.radius) || 0.3)
    const a = Math.random() * Math.PI * 2
    out.set(Math.cos(a) * r * Math.sin(angle), Math.cos(angle) * r, Math.sin(a) * r * Math.sin(angle))
  } else if (shape === 'line') {
    const len = Number(params.length) || 1
    out.set(0, (Math.random() - 0.5) * len, 0)
  } else {
    out.set(0, 0, 0)
  }
  return out
}

function sampleVelocity(v, out) {
  const kind = v?.kind || 'radial'
  const speedRange = v?.speed || [1, 2]
  const speed = Array.isArray(speedRange)
    ? speedRange[0] + Math.random() * (speedRange[1] - speedRange[0])
    : Number(speedRange) || 1
  const dir = v?.dir || [0, 1, 0]
  const spread = Number(v?.spread ?? 0)

  if (kind === 'vector') {
    out.set(dir[0] || 0, dir[1] || 0, dir[2] || 0).normalize().multiplyScalar(speed)
    if (spread > 0) jitterDirection(out, spread).multiplyScalar(speed / Math.max(1e-6, out.length()))
  } else if (kind === 'cone') {
    const a = Math.random() * Math.PI * 2
    const r = Math.tan(spread || 0.3) * Math.random()
    const local = _tmpV2.set(Math.cos(a) * r, 1, Math.sin(a) * r).normalize()
    const up = _tmpV1.set(dir[0] || 0, dir[1] || 1, dir[2] || 0).normalize()
    // Rotate `local` so its +Y aligns with `up`.
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up)
    local.applyQuaternion(q)
    out.copy(local).multiplyScalar(speed)
  } else {
    // radial
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    out.set(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta))
    if (spread > 0) {
      // Bias toward dir
      const biasDir = _tmpV1.set(dir[0] || 0, dir[1] || 0, dir[2] || 0)
      if (biasDir.lengthSq() > 0) {
        biasDir.normalize().multiplyScalar(1 - spread)
        out.multiplyScalar(spread).add(biasDir).normalize()
      }
    }
    out.multiplyScalar(speed)
  }
  return out
}

function jitterDirection(v, spread) {
  v.x += (Math.random() - 0.5) * spread
  v.y += (Math.random() - 0.5) * spread
  v.z += (Math.random() - 0.5) * spread
  return v
}

function resolveTargetPos(name, anchor) {
  if (name === '$target' && anchor.target) return anchor.target
  if (name === '$caster') return anchor.position
  return null
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)) }

// ─────────────────────────────────────────────────────────────────────────
// Anchor motion — runtime advances the spell anchor each tick. Layers
// reference anchor.position so they automatically follow.
// ─────────────────────────────────────────────────────────────────────────

const _motionTmp = new THREE.Vector3()

function applyMotion(anchor, base, target, motion, elapsed, t01) {
  const kind = motion?.kind || 'static'
  const speed = Number(motion?.speed ?? 1)
  if (kind === 'static') {
    anchor.position.copy(base)
    return
  }
  if (kind === 'projectile') {
    // Travel from `base` toward `target` (or default forward) at `speed`
    // m/s, capped at the target distance so we don't overshoot during
    // long durations.
    const dest = target ?? _motionTmp.copy(base).add(new THREE.Vector3(0, 0, 4))
    const dir = _motionTmp.copy(dest).sub(base)
    const fullDist = dir.length()
    if (fullDist < 1e-4) { anchor.position.copy(base); return }
    dir.normalize()
    const travelled = Math.min(elapsed * speed, fullDist)
    anchor.position.copy(base).addScaledVector(dir, travelled)
    return
  }
  if (kind === 'orbit') {
    const radius = Number(motion?.radius ?? 0.8)
    const axis = motion?.axis || [0, 1, 0]
    const angle = elapsed * speed
    // Pick two basis vectors perpendicular to axis.
    const a = _motionTmp.set(axis[0], axis[1], axis[2]).normalize()
    const u = Math.abs(a.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const e1 = new THREE.Vector3().crossVectors(a, u).normalize()
    const e2 = new THREE.Vector3().crossVectors(a, e1).normalize()
    anchor.position.copy(base)
      .addScaledVector(e1, Math.cos(angle) * radius)
      .addScaledVector(e2, Math.sin(angle) * radius)
    return
  }
  if (kind === 'lift') {
    anchor.position.copy(base).add(new THREE.Vector3(0, elapsed * speed, 0))
    return
  }
  if (kind === 'drop') {
    anchor.position.copy(base).add(new THREE.Vector3(0, -elapsed * speed, 0))
    return
  }
  if (kind === 'arc') {
    // Up-then-down parabolic arc toward target (or default forward).
    const dest = target ?? _motionTmp.copy(base).add(new THREE.Vector3(0, 0, 4))
    const horiz = _motionTmp.copy(dest).sub(base)
    horiz.y = 0
    const dist = horiz.length() || 1
    horiz.normalize()
    const apex = Number(motion?.apex ?? 1.2)
    const x = clamp(elapsed / Math.max(0.01, dist / Math.max(0.1, speed)), 0, 1)
    const y = 4 * apex * x * (1 - x)  // parabolic
    anchor.position.copy(base)
      .addScaledVector(horiz, dist * x)
      .add(new THREE.Vector3(0, y, 0))
    return
  }
  anchor.position.copy(base)
}

// 3D value noise via integer-lattice hashing. Returns ~[-1, 1].
function hash3(x, y, z) {
  // Schechter–Bridson style; fast and stable enough for visuals.
  let n = x * 374761393 + y * 668265263 + z * 1274126177
  n = (n ^ (n >>> 13)) * 1274126177
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295 * 2 - 1
}
function smooth3(t) { return t * t * (3 - 2 * t) }
function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const fx = x - ix, fy = y - iy, fz = z - iz
  const u = smooth3(fx), v = smooth3(fy), w = smooth3(fz)
  const lerp = (a, b, t) => a + (b - a) * t
  return lerp(
    lerp(
      lerp(hash3(ix,   iy,   iz),   hash3(ix+1, iy,   iz),   u),
      lerp(hash3(ix,   iy+1, iz),   hash3(ix+1, iy+1, iz),   u), v),
    lerp(
      lerp(hash3(ix,   iy,   iz+1), hash3(ix+1, iy,   iz+1), u),
      lerp(hash3(ix,   iy+1, iz+1), hash3(ix+1, iy+1, iz+1), u), v),
    w,
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Shaders
// ─────────────────────────────────────────────────────────────────────────

// Sprite shapes — single per-layer choice expressed as a uniform int.
// Each is procedural (no textures), evaluated per fragment from gl_PointCoord.
const SHAPE_IDS = {
  circle: 0,  // soft round (default)
  puff:   1,  // softer, gentler falloff (smoke, mist)
  star:   2,  // 5-pointed radial spike pattern
  spark:  3,  // bright tiny dot + thin cross rays
  streak: 4,  // vertical streak (good for rain, embers, lightning)
  cross:  5,  // bright + sign (sparkle highlights)
}

const VERT = /* glsl */`
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uPixelScale;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(2.0, aSize * uPixelScale / max(0.1, -mv.z));
  }
`

const FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  uniform int uShape;

  float shapeCircle(vec2 uv) {
    vec2 d = uv - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) return 0.0;
    float a = 1.0 - r2 * 4.0;
    return a * a;
  }
  float shapePuff(vec2 uv) {
    vec2 d = uv - 0.5;
    float r = length(d) * 2.0;
    return pow(max(0.0, 1.0 - r), 1.6) * 0.85;
  }
  float shapeStar(vec2 uv) {
    vec2 d = uv - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) return 0.0;
    float ang = atan(d.y, d.x);
    // 5-point radial: rim of star modulates radius threshold
    float spike = 0.55 + 0.35 * abs(cos(ang * 2.5));
    float core  = pow(max(0.0, 1.0 - r / spike), 1.4);
    float center = pow(max(0.0, 1.0 - r * 1.6), 4.0);
    return clamp(core + center, 0.0, 1.0);
  }
  float shapeSpark(vec2 uv) {
    vec2 d = (uv - 0.5) * 2.0;
    float core = pow(max(0.0, 1.0 - length(d) * 4.0), 2.0);
    float ray  = max(
      pow(max(0.0, 1.0 - abs(d.y) * 14.0), 3.0) * (1.0 - abs(d.x) * 0.7),
      pow(max(0.0, 1.0 - abs(d.x) * 14.0), 3.0) * (1.0 - abs(d.y) * 0.7)
    );
    return clamp(core * 1.5 + ray * 0.7, 0.0, 1.0);
  }
  float shapeStreak(vec2 uv) {
    vec2 d = (uv - 0.5) * 2.0;
    // narrow vertical band, softly fading top/bottom
    float band = pow(max(0.0, 1.0 - abs(d.x) * 6.0), 2.0);
    float vert = (1.0 - d.y * d.y);
    return clamp(band * vert, 0.0, 1.0);
  }
  float shapeCross(vec2 uv) {
    vec2 d = (uv - 0.5) * 2.0;
    float h = pow(max(0.0, 1.0 - abs(d.y) * 9.0), 2.0) * (1.0 - abs(d.x));
    float v = pow(max(0.0, 1.0 - abs(d.x) * 9.0), 2.0) * (1.0 - abs(d.y));
    return clamp(h + v, 0.0, 1.0);
  }

  void main() {
    float a = 0.0;
    if      (uShape == 1) a = shapePuff(gl_PointCoord);
    else if (uShape == 2) a = shapeStar(gl_PointCoord);
    else if (uShape == 3) a = shapeSpark(gl_PointCoord);
    else if (uShape == 4) a = shapeStreak(gl_PointCoord);
    else if (uShape == 5) a = shapeCross(gl_PointCoord);
    else                  a = shapeCircle(gl_PointCoord);
    if (a <= 0.001) discard;
    gl_FragColor = vec4(vColor * a, a * vAlpha);
  }
`

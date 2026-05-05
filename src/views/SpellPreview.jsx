// Self-contained Three.js canvas that loops the spell forever so users can
// see what they conjured. Uses the same castSpell() that Stage3D will use,
// so what you see here is what you'll see in the game.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { castSpell } from '../lib/spellRuntime.js'

export default function SpellPreview({ spell }) {
  const mountRef = useRef(null)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const [error, setError] = useState(null)

  useEffect(() => { pausedRef.current = paused }, [paused])

  useEffect(() => {
    if (!spell || !mountRef.current) return
    const mount = mountRef.current
    let disposed = false

    // ── Scene setup ────────────────────────────────────────────────
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x141821) // matches --ink

    // Subtle ground grid so users can read motion against something stable.
    const grid = new THREE.GridHelper(4, 8, 0x8a8574, 0x4a4f5b)
    grid.position.y = -0.5
    scene.add(grid)

    // A small "caster" reference dot at origin.
    const caster = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x6d6a5f }),
    )
    scene.add(caster)

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50)
    camera.position.set(1.6, 1.0, 2.4)
    camera.lookAt(0, 0.4, 0)

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    } catch (e) {
      setError('WebGL unavailable in this browser.')
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    // ACES filmic tone mapping gives bloom a clean, photographic falloff
    // instead of clipping to flat white the moment additive particles stack.
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)

    // ── Postprocessing: bloom is the single biggest factor in "magic" feel.
    // Read intensity/threshold from spell.schema.post[].bloom; sane defaults
    // otherwise. radius is fixed at a soft middle value.
    const bloomDef = (spell.schema?.post ?? []).find((p) => p?.type === 'bloom') || {}
    // Tuned down — earlier default was washing out everything.
    const bloomStrength  = Number(bloomDef.intensity ?? 0.55)
    const bloomThreshold = Number(bloomDef.threshold ?? 0.7)
    const bloomRadius    = Number(bloomDef.radius ?? 0.55)

    // HalfFloat target so additive particle accumulation can exceed 1.0 in
    // brightness — that's what makes bloom feel luminous instead of just
    // softly blurred. Without this, hot pixels are clamped before bloom sees them.
    const hdrTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
    })
    const composer = new EffectComposer(renderer, hdrTarget)
    composer.addPass(new RenderPass(scene, camera))
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      bloomStrength,
      bloomRadius,
      bloomThreshold,
    )
    composer.addPass(bloomPass)
    composer.addPass(new OutputPass())

    // ── Sizing ─────────────────────────────────────────────────────
    const resize = () => {
      const w = mount.clientWidth || 320
      const h = mount.clientHeight || 240
      renderer.setSize(w, h, false)
      composer.setSize(w, h)
      bloomPass.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    // ── Spell loop ─────────────────────────────────────────────────
    const anchor = { position: new THREE.Vector3(0, 0, 0) }
    let handle = null
    let restartTimer = 0

    function startCast() {
      try {
        // The store wraps the schema as { id, name, prompt, schema, createdAt };
        // the runtime wants the inner schema directly.
        handle = castSpell(scene, spell.schema, anchor)
      } catch (e) {
        setError(`Cast failed: ${e.message || e}`)
        handle = null
      }
    }
    startCast()

    // ── Camera orbit ───────────────────────────────────────────────
    let theta = 0
    const radius = 2.6

    // ── Frame loop ─────────────────────────────────────────────────
    let raf = 0
    let last = performance.now()
    const tick = () => {
      if (disposed) return
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now

      if (!pausedRef.current) {
        // Slow orbit.
        theta += dt * 0.18
        camera.position.set(Math.cos(theta) * radius, 1.0, Math.sin(theta) * radius)
        camera.lookAt(0, 0.4, 0)

        if (handle) {
          const alive = handle.tick(dt, { camera })
          if (!alive) {
            handle.dispose()
            handle = null
            restartTimer = 0
          }
        } else {
          restartTimer += dt
          if (restartTimer > 0.6) startCast()
        }
      }

      composer.render(dt)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      if (handle) handle.dispose()
      grid.geometry.dispose()
      grid.material.dispose()
      caster.geometry.dispose()
      caster.material.dispose()
      bloomPass.dispose?.()
      composer.dispose?.()
      hdrTarget.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [spell])

  return (
    <div className="spell-preview-bleed" ref={mountRef}>
      <button
        type="button"
        className="spell-preview-toggle"
        onClick={() => setPaused((p) => !p)}
        title={paused ? 'Play' : 'Pause'}
      >
        {paused ? '▶' : '❚❚'}
      </button>
      {error && <div className="spell-preview-err">{error}</div>}
    </div>
  )
}

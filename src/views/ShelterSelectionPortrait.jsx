import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import {
  createCharacterRegistry,
  createAvatarFactory,
  animationLibrary,
} from '../lib/shelterWorld/index.js'
import config from '../config.js'

/**
 * Small 3D portrait that renders the selected character in an idle
 * pose. Mounted bottom-left of the shelter stage when a character is
 * selected (single-tap, not focused). Uses the same avatarFactory the
 * shelter uses so the rig + materials read identically.
 *
 * Props:
 *   pubkey — null hides the portrait; non-null spawns that character.
 */
// Same dollhouse→human upscale RoomShelterPreview uses, so the avatar
// reads at human proportions in the framed camera.
const SHELTER_AVATAR_HEIGHT_M = 0.5
const AVATAR_HEIGHT_M = 1.7
const AVATAR_UPSCALE = AVATAR_HEIGHT_M / SHELTER_AVATAR_HEIGHT_M

export default function ShelterSelectionPortrait({ pubkey }) {
  const hostRef = useRef(null)

  useEffect(() => {
    if (!pubkey) return
    const host = hostRef.current
    if (!host) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.setClearColor(0x000000, 0)
    host.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'

    const scene = new THREE.Scene()
    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404044, 0.4)
    scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 0.7)
    key.position.set(2, 3, 4)
    scene.add(key)
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.55

    // Framing: full body, slight downward angle. Avatar sits at origin
    // with its feet on y=0 after the upscale.
    const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 50)
    camera.position.set(0, 1.0, 3.0)
    camera.lookAt(0, 0.9, 0)

    // Postprocessing: hard, non-glowing yellow silhouette outline.
    // edgeGlow=0 + pulsePeriod=0 + alpha output keeps the bg
    // transparent so the portrait just shows the character.
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const outlinePass = new OutlinePass(new THREE.Vector2(1, 1), scene, camera)
    outlinePass.edgeStrength = 10.0
    outlinePass.edgeGlow = 0.0
    outlinePass.edgeThickness = 2.0
    outlinePass.pulsePeriod = 0.0
    outlinePass.visibleEdgeColor.set(0xffd84a)
    outlinePass.hiddenEdgeColor.set(0xffd84a)
    composer.addPass(outlinePass)
    composer.addPass(new OutputPass())

    const resize = () => {
      const w = host.clientWidth || 1
      const h = host.clientHeight || 1
      renderer.setSize(w, h, false)
      composer.setSize(w, h)
      outlinePass.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    const registry = createCharacterRegistry({ bridgeUrl: config.agentSandbox?.bridgeUrl })
    const factory = createAvatarFactory({ registry })

    let wrapper = null
    let cancelled = false

    factory.spawn(pubkey).then((handle) => {
      if (cancelled) return
      wrapper = new THREE.Group()
      // Half the human upscale — character reads as ~85cm tall in the
      // portrait box (smaller, fits the lower-left footprint better).
      wrapper.scale.setScalar(AVATAR_UPSCALE * 0.5)
      // 3/4 profile — character faces camera-front-left.
      wrapper.rotation.y = Math.PI / 6
      // Shift up + to the left within the portrait viewport.
      wrapper.position.set(-0.175, 0.125, 0)
      wrapper.add(handle.object3d)
      scene.add(wrapper)
      // Outline pass targets the visible avatar object.
      outlinePass.selectedObjects = [handle.object3d]

      // Play idle. Kimodo rigs expose setMotion; fallback rigs ignore.
      const applyIdle = (motion) => {
        if (handle.animator?.setMotion && motion) {
          handle.animator.setMotion(motion, { loop: true, applyRootTranslation: false })
        }
      }
      const cached = animationLibrary.peek(animationLibrary.getRoleId('idle'))
      if (cached) {
        applyIdle(cached)
      } else {
        animationLibrary.getRole('idle').then(applyIdle).catch(() => {})
      }
    }).catch((err) => console.warn('[SelectionPortrait] spawn:', err))

    let raf = 0
    const tick = () => {
      if (cancelled) return
      raf = requestAnimationFrame(tick)
      try { factory.tick?.() } catch {}
      composer.render()
    }
    tick()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      try { ro.disconnect() } catch {}
      try { factory.dispose?.() } catch {}
      try { registry.dispose?.() } catch {}
      try { pmrem.dispose() } catch {}
      try { composer.dispose() } catch {}
      try { renderer.dispose() } catch {}
      try { host.removeChild(renderer.domElement) } catch {}
    }
  }, [pubkey])

  if (!pubkey) return null
  // Key on pubkey so React remounts the element when the selection
  // changes — that retriggers the slide-in animation each time.
  return <div key={pubkey} ref={hostRef} className="shelter-selection-portrait" />
}

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { buildGrayBox, frameCamera } from '../lib/grayBoxBuilder.js'
import {
  createCharacterRegistry,
  createAvatarFactory,
} from '../lib/shelterWorld/index.js'
import config from '../config.js'
import {
  ROOM_LAYOUT_STATUS,
  fetchLayout,
  getLayout,
  subscribe as subLayouts,
} from '../lib/roomLayoutStore.js'
import {
  ROOM_ASSET_STATUS,
  getStatus as getAssetStatus,
  refreshRoomFromBridge,
  subscribe as subAssets,
} from '../lib/roomAssetStore.js'

/**
 * Shelter-style preview of a generated room with avatars walking
 * around. Avatars are spawned via the SAME avatarFactory + character
 * registry the shelter game uses, so any kimodo rig / mapping the
 * receptionist (Edi) has applied to him in shelter is applied here
 * too — letting the user A/B-compare a generated room against the
 * shelter's render fidelity.
 *
 * Read-only: no TransformControls, no drag-drop, no editing. Camera is
 * a fixed iso framing.
 */
// Edi Schmid — the shelter's receptionist NPC. Hard-coded here for
// the preview because we want a deterministic, recognisable character
// that the user can compare against the shelter render.
const EDI_PUBKEY = '7a887ac2f1dc8d8d81e1d19ae0372d616f0eed5ba76afc57b4aa1135af6eb2df'
// Real-meter human height used to scale Edi up from the shelter's
// dollhouse target (~0.5m) to match the room's real-world metres.
// avatarFactory clamps to its own TARGET_HEIGHT internally; this
// outer scale lifts the result back to human size.
const AVATAR_HEIGHT_M = 1.7
const SHELTER_AVATAR_HEIGHT_M = 0.5
const AVATAR_UPSCALE = AVATAR_HEIGHT_M / SHELTER_AVATAR_HEIGHT_M

export default function RoomShelterPreview({ roomId, height = 480 }) {
  const containerRef = useRef(null)
  const [tick, setTick] = useState(0)
  const id = roomId

  useEffect(() => {
    if (!id) return
    fetchLayout(id)
    refreshRoomFromBridge(id)  // probe bridge for existing prop GLBs
    return subLayouts(() => setTick((t) => t + 1))
  }, [id])

  useEffect(() => {
    return subAssets(() => setTick((t) => t + 1))
  }, [])

  // Build the scene only once we actually have a layout. Track readiness
  // via a separate effect dep so the heavy three.js setup runs the first
  // time the layout transitions to ready, not on every asset tick.
  const layoutEntry = id ? getLayout(id) : null
  const layoutReady = layoutEntry?.status === ROOM_LAYOUT_STATUS.ready
  useEffect(() => {
    if (!id || !containerRef.current || !layoutReady) return
    const layout = layoutEntry.layout
    const container = containerRef.current

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(layout.palette?.wall || '#cdd1d6').multiplyScalar(0.85)
    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404044, 0.4)
    scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 0.6)
    key.position.set(2, 4, 3)
    scene.add(key)
    // PBR environment so TRELLIS / Hunyuan GLB materials read with the
    // diffuse + specular response they were baked against, instead of
    // collapsing to near-black under direct-light-only setups.
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.6

    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200)
    const { position, target } = frameCamera(layout)
    camera.position.copy(position)
    camera.lookAt(target)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.copy(target)
    controls.minDistance = 1.2
    controls.maxDistance = Math.max(layout.dimensions.width, layout.dimensions.depth) * 4

    const built = buildGrayBox(layout)
    scene.add(built.group)
    // Convert gray-box meshes to wireframe immediately — we want the
    // GLBs (where ready) to read as the room, with bbox guides faint.
    for (const wrapper of built.props.values()) {
      const box = wrapper.children.find((c) => c.userData?.isGrayBoxMesh)
      if (box?.material) {
        box.material.wireframe = true
        box.material.transparent = true
        box.material.opacity = 0.18
        box.material.depthWrite = false
      }
    }

    // ── Avatar — Edi via the shelter's avatarFactory ────────────
    // Use the same avatarFactory + characterRegistry the shelter does
    // so the preview renders Edi with whatever rig / mapping / idle
    // motion the shelter applies. Lets the user A/B-compare a
    // generated room against the shelter's avatar fidelity.
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://unpkg.com/three@0.184.0/examples/jsm/libs/draco/gltf/')
    const loader = new GLTFLoader().setDRACOLoader(draco)
    const clock = new THREE.Clock()
    const avatars = [] // { wrapper, target, speed, waitUntil }
    const registry = createCharacterRegistry({ bridgeUrl: config.agentSandbox?.bridgeUrl })
    const factory = createAvatarFactory({ registry })

    const dims = layout.dimensions
    const margin = 0.5
    function randomWaypoint() {
      return new THREE.Vector3(
        (Math.random() - 0.5) * (dims.width - margin * 2),
        0,
        (Math.random() - 0.5) * (dims.depth - margin * 2),
      )
    }

    factory.spawn(EDI_PUBKEY).then((handle) => {
      // avatarFactory targets shelter dollhouse scale. Wrap in an
      // outer Group scaled up to human size so Edi reads at 1.7m in
      // the room's real-metres space.
      const wrapper = new THREE.Group()
      wrapper.scale.setScalar(AVATAR_UPSCALE)
      wrapper.add(handle.object3d)
      const start = randomWaypoint()
      wrapper.position.set(start.x, 0, start.z)
      scene.add(wrapper)
      avatars.push({
        wrapper,
        target: randomWaypoint(),
        speed: 0.6,
        waitUntil: 0,
      })
    }).catch((err) => console.warn('[RoomShelterPreview] Edi spawn:', err))

    function tickAvatars(_dt) {
      const now = performance.now() / 1000
      // Tick factory animators (kimodo motion + AnimationMixer).
      try { factory.tick?.() } catch {}
      for (const a of avatars) {
        if (a.waitUntil > now) continue
        const dx = a.target.x - a.wrapper.position.x
        const dz = a.target.z - a.wrapper.position.z
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist < 0.15) {
          a.target = randomWaypoint()
          a.waitUntil = now + 0.4 + Math.random() * 1.2
          continue
        }
        const step = Math.min(dist, a.speed * _dt)
        a.wrapper.position.x += (dx / dist) * step
        a.wrapper.position.z += (dz / dist) * step
        a.wrapper.rotation.y = Math.atan2(dx, dz)
      }
    }

    // GLB swap: reuse the same approach as RoomPreview3D — when an
    // asset becomes ready, parent its scene under the prop wrapper so
    // its world transform inherits position/rotation/scale.
    const loaded = new Map()
    function syncGlbs() {
      for (const [propId, wrapper] of built.props.entries()) {
        if (loaded.has(propId)) continue
        const status = getAssetStatus(propId)
        if (status?.status !== ROOM_ASSET_STATUS.ready || !status.modelUrl) continue
        const propData = layout.props.find((p) => p.id === propId)
        if (!propData) continue
        loader.load(status.modelUrl, (gltf) => {
          const obj = gltf.scene
          obj.updateMatrixWorld(true)
          const bb = new THREE.Box3().setFromObject(obj)
          const sz = bb.getSize(new THREE.Vector3())
          obj.scale.x *= propData.size.w / Math.max(sz.x, 0.001)
          obj.scale.y *= propData.size.h / Math.max(sz.y, 0.001)
          obj.scale.z *= propData.size.d / Math.max(sz.z, 0.001)
          obj.updateMatrixWorld(true)
          const after = new THREE.Box3().setFromObject(obj)
          obj.position.y -= after.min.y
          wrapper.add(obj)
          loaded.set(propId, obj)
        }, undefined, (err) => console.warn(`[RoomShelterPreview] ${propId} GLB:`, err))
      }
    }

    let rafId = 0
    function loop() {
      const dt = clock.getDelta()
      controls.update()
      syncGlbs()
      tickAvatars(dt)
      renderer.render(scene, camera)
      rafId = requestAnimationFrame(loop)
    }
    function resize() {
      const w = container.clientWidth
      const h = container.clientHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)
    rafId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId)
      try { for (const a of avatars) a.factoryHandle?.dispose?.() } catch {}
      try { registry.dispose?.() } catch {}
      ro.disconnect()
      controls.dispose()
      try { pmrem.dispose() } catch {}
      try { scene.environment?.dispose() } catch {}
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }, [id, layoutReady])

  return <div ref={containerRef} style={{ width: '100%', height, minHeight: 240, position: 'relative', borderRadius: 8, overflow: 'hidden', background: '#1a1d22' }} />
}

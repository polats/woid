import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { buildGrayBox, frameCamera } from '../lib/grayBoxBuilder.js'
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
 * Shelter-style preview of a generated room — same gray-box + GLB
 * pipeline as RoomPreview3D, but with a single human-scale avatar
 * standing inside the room so we can sanity-check scale.
 *
 * Avatar is loaded from /avatar_animated.glb (already in /public). It
 * is normalised to ~1.7 m tall (real human scale) to match the room's
 * real-world metres. No animation is required for this preview — we
 * just want to see "does the room feel the right size for a person?".
 *
 * Read-only: no TransformControls, no drag-drop, no editing. Camera is
 * a fixed iso framing. Use this from a route like /shelter-room/:id
 * to give the user a "view in shelter" affordance from the room editor.
 */
const AVATAR_HEIGHT_M = 1.7

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

    // ── Avatars walking around the room ─────────────────────────
    // Spawn 1-3 avatars that wander between random waypoints so the
    // room reads as inhabited space. Avoids touching the shelter's
    // own avatar/animation systems — minimal local copy that just
    // plays whatever clip the GLB ships with and lerps position.
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://unpkg.com/three@0.184.0/examples/jsm/libs/draco/gltf/')
    const loader = new GLTFLoader().setDRACOLoader(draco)
    const clock = new THREE.Clock()
    const avatars = [] // { root, mixer, action, target, speed, baseY }

    const dims = layout.dimensions
    const margin = 0.5
    function randomWaypoint() {
      return new THREE.Vector3(
        (Math.random() - 0.5) * (dims.width - margin * 2),
        0,
        (Math.random() - 0.5) * (dims.depth - margin * 2),
      )
    }

    const AVATAR_COUNT = Math.min(3, Math.max(1, Math.floor(dims.width / 3)))
    loader.load('/avatar_animated.glb', (gltf) => {
      // Shared template — clone per avatar so each can move and animate
      // independently. SkeletonUtils would be needed for true skinned
      // duplicates; the existing avatar GLB happens to clone reasonably
      // for our purposes since it's a simple rig.
      // Compute scale + foot-offset from the template ONCE so each
      // clone starts from the same reference. Computing per-clone
      // makes scales compound when clones reuse shared transforms.
      const tmplBbox = new THREE.Box3().setFromObject(gltf.scene)
      const tmplSize = tmplBbox.getSize(new THREE.Vector3())
      const tmplScale = AVATAR_HEIGHT_M / Math.max(tmplSize.y, 0.01)

      for (let i = 0; i < AVATAR_COUNT; i += 1) {
        // SkeletonUtils.clone correctly clones skinned mesh + skeleton
        // so each avatar can move/animate independently. Plain
        // .clone(true) shares the skeleton and locks every clone at the
        // template's pose/position.
        const root = SkeletonUtils.clone(gltf.scene)
        root.scale.setScalar(tmplScale)
        root.updateMatrixWorld(true)
        const live = new THREE.Box3().setFromObject(root)
        const baseY = -live.min.y
        const start = randomWaypoint()
        root.position.set(start.x, baseY, start.z)
        scene.add(root)
        // Animation mixer — play the first clip the GLB ships with
        // (typically idle or walk-cycle). If there are multiple clips,
        // prefer one whose name suggests motion.
        let mixer = null, action = null
        if (gltf.animations?.length) {
          const clips = gltf.animations
          const walkClip = clips.find((c) => /walk|run|move/i.test(c.name)) || clips[0]
          mixer = new THREE.AnimationMixer(root)
          action = mixer.clipAction(walkClip)
          action.play()
        }
        avatars.push({
          root, mixer, action,
          target: randomWaypoint(),
          speed: 0.45 + Math.random() * 0.25,
          baseY,
          waitUntil: 0,
        })
      }
    })

    function tickAvatars(dt) {
      const now = performance.now() / 1000
      for (const a of avatars) {
        if (a.mixer) a.mixer.update(dt)
        if (a.waitUntil > now) continue
        const dx = a.target.x - a.root.position.x
        const dz = a.target.z - a.root.position.z
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist < 0.15) {
          // Reached waypoint — pause briefly, then pick a new one.
          a.target = randomWaypoint()
          a.waitUntil = now + 0.4 + Math.random() * 1.2
          continue
        }
        const step = Math.min(dist, a.speed * dt)
        a.root.position.x += (dx / dist) * step
        a.root.position.z += (dz / dist) * step
        a.root.rotation.y = Math.atan2(dx, dz)
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
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }, [id, layoutReady])

  return <div ref={containerRef} style={{ width: '100%', height, minHeight: 240, position: 'relative', borderRadius: 8, overflow: 'hidden', background: '#1a1d22' }} />
}

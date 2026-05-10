import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
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

    // Avatar — sits on the floor near the front of the room, centred
    // on x. Loaded async so the room renders immediately.
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://unpkg.com/three@0.184.0/examples/jsm/libs/draco/gltf/')
    const loader = new GLTFLoader().setDRACOLoader(draco)
    let avatarRoot = null
    loader.load('/avatar_animated.glb', (gltf) => {
      const root = gltf.scene
      const bbox = new THREE.Box3().setFromObject(root)
      const size = bbox.getSize(new THREE.Vector3())
      const scale = AVATAR_HEIGHT_M / Math.max(size.y, 0.01)
      root.scale.setScalar(scale)
      root.updateMatrixWorld(true)
      const live = new THREE.Box3().setFromObject(root)
      root.position.y = -live.min.y
      root.position.z = layout.dimensions.depth / 2 - 0.8
      avatarRoot = root
      scene.add(root)
    })

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
      controls.update()
      syncGlbs()
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

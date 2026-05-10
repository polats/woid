import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
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
 * 3D preview driven by the room's layout JSON. Builds the gray-box
 * (shell + per-prop boxes at exact positions) via the pure builder;
 * swaps a prop's gray box for its TRELLIS GLB when one becomes ready.
 *
 * Click-to-select: a mouse click that didn't drag (i.e. wasn't an
 * orbit-control gesture) raycasts against prop meshes. The hit's
 * propId is forwarded via `onPropSelect`. Pass the selected propId
 * back via `selectedPropId` to highlight the matching mesh.
 *
 * `interactive` enables OrbitControls. Set to false for thumbnail-style
 * static iso shots that auto-rotate.
 */
export default function RoomPreview3D({
  roomId,
  room,
  interactive = true,
  height = 280,
  selectedPropId = null,
  onPropSelect,
  transformMode = 'translate',  // 'translate' | 'rotate' | 'scale'
  onPropTransform,              // (propId, { position, rotation_y, size }) => void
  rebuildKey = 0,               // bump from parent to force a scene rebuild
  onPropDrop,                   // ({ propId, position }) => void — drag-drop from prop library
}) {
  const containerRef = useRef(null)
  const propMeshesRef = useRef(new Map())   // propId → mesh (gray-box)
  const propMaterialsRef = useRef(new Map()) // propId → original baseColor hex
  const selectedRef = useRef(null)
  const tcRef = useRef(null)
  const propsRef = useRef(null)             // Map(propId → propData) — for size lookup on commit
  const [, setTick] = useState(0)
  const id = roomId || room?.id

  // Trigger fetch + subscribe to layout changes. We track a structural
  // signature (dimensions + per-prop transforms) so the heavy scene
  // rebuild fires only when geometry actually changed — palette and
  // name edits don't trigger a flicker.
  const structureSigRef = useRef(null)
  const [structureKey, setStructureKey] = useState(0)
  useEffect(() => {
    if (!id) return
    fetchLayout(id)
    return subLayouts(() => {
      setTick((t) => t + 1)
      const layout = getLayout(id)?.layout
      if (!layout) return
      const dims = layout.dimensions || {}
      const arch = layout.architecture || {}
      const sig = `${dims.width}|${dims.depth}|${dims.height}|`
        + `${layout.category || ''}|${arch.trim || ''}|${arch.ceiling || ''}|${arch.floor || ''}|`
        + (layout.props || [])
          .map((p) => `${p.id}:${p.size?.w},${p.size?.h},${p.size?.d}@${p.position?.x},${p.position?.y},${p.position?.z}r${p.rotation_y || 0}`)
          .join(';')
      if (structureSigRef.current !== sig) {
        structureSigRef.current = sig
        setStructureKey((k) => k + 1)
      }
    })
  }, [id])

  useEffect(() => {
    if (!id || !containerRef.current) return
    const layoutEntry = getLayout(id)
    const layout = layoutEntry?.status === ROOM_LAYOUT_STATUS.ready ? layoutEntry.layout : null
    if (!layout) return
    const container = containerRef.current

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = null
    // Editing-friendly lighting: bright soft fill so every prop reads
    // clearly. The atmospheric per-room fluorescent + accent point
    // lights still come from the gray-box builder; this layer just
    // ensures nothing's lost to shadow during layout.
    scene.add(new THREE.AmbientLight(0xffffff, 0.7))
    const hemi = new THREE.HemisphereLight(0xffffff, 0xb6b0a0, 0.55)
    scene.add(hemi)
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.4)
    keyLight.position.set(2, 4, 3)
    scene.add(keyLight)
    // PBR environment so TRELLIS / Hunyuan GLBs read with their baked
    // diffuse + specular response. Without this they collapse to
    // near-black, which is why props look dark in the editor view.
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.6

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200)
    const { position, target } = frameCamera(layout)
    camera.position.copy(position)
    camera.lookAt(target)

    const controls = interactive ? new OrbitControls(camera, renderer.domElement) : null
    if (controls) {
      controls.enableDamping = true
      controls.target.copy(target)
      controls.minDistance = 1.5
      controls.maxDistance = Math.max(layout.dimensions.width, layout.dimensions.depth) * 3
      controls.maxPolarAngle = Math.PI / 2 - 0.05
    }

    // Build gray-box and stash refs for selection / GLB swap.
    let built = buildGrayBox(layout)
    scene.add(built.group)
    propMeshesRef.current = new Map(built.props)  // map propId → wrapper Group
    propMaterialsRef.current = new Map()
    propsRef.current = new Map((layout.props || []).map((p) => [p.id, p]))
    for (const [propId, wrapper] of built.props.entries()) {
      // Capture the BoxMesh's original colour for highlight restore.
      const boxMesh = wrapper.children.find((c) => c.userData?.isGrayBoxMesh)
      if (boxMesh?.material?.color) {
        propMaterialsRef.current.set(propId, boxMesh.material.color.getHex())
      }
    }
    applySelection(selectedRef.current)

    // ── TransformControls (move/rotate/scale handles) ───────────
    // Attached lazily when a prop is selected. While the user is
    // dragging a handle, OrbitControls is paused so the camera
    // doesn't fight the gizmo.
    const tc = new TransformControls(camera, renderer.domElement)
    tc.size = 0.7
    // r144+ requires accessing the helper; older versions add to the
    // scene directly. Try both for compatibility.
    if (typeof tc.getHelper === 'function') scene.add(tc.getHelper())
    else scene.add(tc)
    tc.addEventListener('dragging-changed', (e) => {
      if (controls) controls.enabled = !e.value
      if (!e.value) commitTransform(tc.object)
    })
    tcRef.current = tc

    function round3(n) { return Math.round(n * 1000) / 1000 }
    function commitTransform(obj) {
      if (!obj || !obj.userData?.propId) return
      const propId = obj.userData.propId
      const orig = propsRef.current?.get(propId)
      if (!orig) return
      // Bake mesh.scale into the prop's bounding box so the geometry
      // gets rebuilt at the new size on next render. Reset scale so
      // gizmo handles stay 1:1 with the freshly-built mesh.
      const sx = obj.scale.x, sy = obj.scale.y, sz = obj.scale.z
      obj.scale.set(1, 1, 1)
      const next = {
        position: { x: round3(obj.position.x), y: round3(obj.position.y), z: round3(obj.position.z) },
        rotation_y: round3(obj.rotation.y),
        size: {
          w: round3(orig.size.w * sx),
          h: round3(orig.size.h * sy),
          d: round3(orig.size.d * sz),
        },
      }
      onPropTransform?.(propId, next)
    }

    // ── Raycaster click handling ─────────────────────────────────
    // Distinguish click from drag: track mousedown coords, only
    // raycast when the mouseup is within a few pixels.
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    let downX = 0, downY = 0, downAt = 0
    function onPointerDown(e) {
      downX = e.clientX; downY = e.clientY; downAt = Date.now()
    }
    function onPointerUp(e) {
      const dx = Math.abs(e.clientX - downX)
      const dy = Math.abs(e.clientY - downY)
      const dt = Date.now() - downAt
      if (dx > 5 || dy > 5 || dt > 400) return  // dragged or held — orbit gesture
      // Ctrl/Cmd-click: snap the camera to a shelter-style head-on
      // dollhouse frame so the user can compare against the shelter
      // game view without leaving the editor. No raycast; just camera.
      if (e.ctrlKey || e.metaKey) {
        const dims = layout.dimensions || {}
        const w = dims.width || 4
        const h = dims.height || 1.1
        const d = dims.depth || 3
        // Shelter renders rooms in a front-facing dollhouse cross-
        // section. Pull the camera back along +z far enough to fit
        // the cell horizontally + vertically, looking at room centre.
        const aspect = renderer.domElement.clientWidth / Math.max(renderer.domElement.clientHeight, 1)
        const fov = camera.fov * Math.PI / 180
        const distH = (h / 2) / Math.tan(fov / 2)
        const distW = (w / 2) / (Math.tan(fov / 2) * aspect)
        const distance = Math.max(distH, distW) * 1.15 + d / 2
        camera.position.set(0, h / 2, distance)
        if (controls) {
          controls.target.set(0, h / 2, 0)
          controls.update()
        } else {
          camera.lookAt(0, h / 2, 0)
        }
        return
      }
      const rect = renderer.domElement.getBoundingClientRect()
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(ndc, camera)
      // Cast against everything under built.group; any hit's userData
      // chain lets us recover the propId we tagged in grayBoxBuilder.
      const hits = raycaster.intersectObjects(built.group.children, true)
      let hitId = null
      for (const h of hits) {
        let o = h.object
        while (o && !o.userData?.propId) o = o.parent
        if (o?.userData?.propId) { hitId = o.userData.propId; break }
      }
      onPropSelect?.(hitId)
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    // ── Drag-drop from prop library onto the floor plane ───────
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    function onDragOver(e) {
      // Only handle our prop drops; let other drags pass.
      const types = e.dataTransfer?.types
      if (types && Array.from(types).includes('application/x-woid-prop-id')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    }
    function onDrop(e) {
      const propId = e.dataTransfer?.getData('application/x-woid-prop-id')
      if (!propId) return
      e.preventDefault()
      const rect = renderer.domElement.getBoundingClientRect()
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(ndc, camera)
      const hit = new THREE.Vector3()
      const hitOk = raycaster.ray.intersectPlane(floorPlane, hit)
      if (!hitOk) return
      // Clamp into the room bounds so dropped props don't end up
      // outside the walls.
      const w = layout.dimensions.width / 2 - 0.3
      const d = layout.dimensions.depth / 2 - 0.3
      hit.x = Math.max(-w, Math.min(w, hit.x))
      hit.z = Math.max(-d, Math.min(d, hit.z))
      onPropDrop?.({
        propId,
        position: { x: round3(hit.x), y: 0, z: round3(hit.z) },
      })
      function round3(n) { return Math.round(n * 1000) / 1000 }
    }
    container.addEventListener('dragover', onDragOver)
    container.addEventListener('drop', onDrop)

    // ── GLB swap on per-prop generation ──────────────────────────
    // The GLB becomes a child of the existing prop wrapper, so the
    // transform gizmo's manipulations of the wrapper apply to BOTH
    // the gray-box AND the GLB in real time. The gray-box switches
    // to a translucent wireframe so the bounding box stays visible
    // (size + collision reference for editing).
    const loader = new GLTFLoader()
    const loadedMeshes = new Map()
    function syncGlbs() {
      for (const [propId, wrapper] of built.props.entries()) {
        if (loadedMeshes.has(propId)) continue
        const status = getAssetStatus(propId)
        if (status?.status !== ROOM_ASSET_STATUS.ready || !status.modelUrl) continue
        const propData = layout.props.find((p) => p.id === propId)
        if (!propData) continue
        loader.load(
          status.modelUrl,
          (gltf) => {
            // Normalise gltf to its own bbox in local coords (centred
            // on XZ, sitting on y=0). The wrapper owns the outer
            // position/rotation/scale.
            fitToBox(gltf.scene, propData.size)
            gltf.scene.userData.isGltfChild = true
            wrapper.add(gltf.scene)
            loadedMeshes.set(propId, gltf.scene)
            // Convert the gray-box mesh into a translucent wireframe
            // so the bounding box stays as a sizing/collision guide.
            const boxMesh = wrapper.children.find((c) => c.userData?.isGrayBoxMesh)
            if (boxMesh?.material) {
              boxMesh.material.wireframe = true
              boxMesh.material.transparent = true
              boxMesh.material.opacity = 0.32
              boxMesh.material.depthWrite = false
            }
          },
          undefined,
          (err) => console.warn(`[RoomPreview3D] ${propId} GLB load failed:`, err),
        )
      }
    }
    syncGlbs()
    const unsubAssets = subAssets(() => syncGlbs())
    const unsubLayouts = subLayouts(() => { /* layout-rebuild deferred */ })

    // ── Render loop ──────────────────────────────────────────────
    let running = true
    const clock = new THREE.Clock()
    function tick() {
      if (!running) return
      requestAnimationFrame(tick)
      controls?.update()
      if (!interactive) {
        scene.rotation.y += clock.getDelta() * 0.15
      }
      renderer.render(scene, camera)
    }
    tick()

    const ro = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = container
      if (!clientWidth || !clientHeight) return
      renderer.setSize(clientWidth, clientHeight, false)
      camera.aspect = clientWidth / clientHeight
      camera.updateProjectionMatrix()
    })
    ro.observe(container)

    return () => {
      running = false
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('dragover', onDragOver)
      container.removeEventListener('drop', onDrop)
      unsubAssets()
      unsubLayouts()
      ro.disconnect()
      tc.detach()
      tc.dispose?.()
      tcRef.current = null
      controls?.dispose?.()
      try { pmrem.dispose() } catch {}
      try { scene.environment?.dispose() } catch {}
      built.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.()
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.())
        else o.material?.dispose?.()
      })
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
      propMeshesRef.current = new Map()
      propMaterialsRef.current = new Map()
      propsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, getLayout(id)?.status, interactive, structureKey, rebuildKey])

  // Re-apply highlight when the parent's selection changes.
  useEffect(() => {
    selectedRef.current = selectedPropId
    applySelection(selectedPropId)
  }, [selectedPropId])

  // Attach/detach the TransformControls gizmo when the selected prop
  // (or its mesh, after a rebuild) changes. Update mode when the
  // parent toggles translate/rotate/scale.
  useEffect(() => {
    const tc = tcRef.current
    if (!tc) return
    const meshes = propMeshesRef.current
    if (selectedPropId && meshes.has(selectedPropId)) {
      tc.attach(meshes.get(selectedPropId))
      tc.setMode(transformMode)
    } else {
      tc.detach()
    }
  }, [selectedPropId, transformMode, structureKey])

  function applySelection(propId) {
    const wrappers = propMeshesRef.current
    const originals = propMaterialsRef.current
    if (!wrappers) return
    for (const [pid, wrapper] of wrappers.entries()) {
      const isSel = pid === propId
      const boxMesh = wrapper.children?.find((c) => c.userData?.isGrayBoxMesh)
      if (!boxMesh?.material) continue
      if (isSel) {
        boxMesh.material.emissive = new THREE.Color(0xffd84a)
        boxMesh.material.emissiveIntensity = 0.35
      } else {
        boxMesh.material.emissive = new THREE.Color(0x000000)
        boxMesh.material.emissiveIntensity = 0
        const baseHex = originals.get(pid)
        if (baseHex != null) boxMesh.material.color.setHex(baseHex)
      }
    }
  }

  return (
    <div
      ref={containerRef}
      className="room-mini-preview"
      style={{ width: '100%', height }}
    />
  )
}

/** Stretch an object to fill the target { w, h, d } bounding box
 *  exactly (per-axis scaling — the GLB conforms to whatever shape the
 *  user has set the wireframe cage to). Centres on XZ and sits on y=0. */
function fitToBox(obj, dim) {
  const box = new THREE.Box3().setFromObject(obj)
  const size = new THREE.Vector3()
  box.getSize(size)
  if (size.x === 0 || size.y === 0 || size.z === 0) return
  // Per-axis scaling so the GLB FILLS the bbox (no letterboxing). This
  // matches the user's expectation when resizing the wireframe cage:
  // the rendered prop tracks the cage shape exactly.
  obj.scale.x *= dim.w / size.x
  obj.scale.y *= dim.h / size.y
  obj.scale.z *= dim.d / size.z
  const box2 = new THREE.Box3().setFromObject(obj)
  const center = new THREE.Vector3()
  box2.getCenter(center)
  obj.position.x -= center.x
  obj.position.z -= center.z
  obj.position.y -= box2.min.y
}

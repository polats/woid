import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { createPanZoomControls } from '../lib/panZoomControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { buildGrayBox, frameCamera } from '../lib/grayBoxBuilder.js'
import { wallSnapLocalPos } from '../lib/buildLayoutDressing.js'
import { ROOM_DEPTH } from '../lib/shelterDressing.js'
import { TILT_MAX as SHELTER_TILT } from './ShelterStage3D.jsx'

// Shelter cell dimensions (gridW=2 × cellWidth=2, gridH=1 × cellHeight=1.1).
// The room editor renders the layout pre-scaled into this cell so it
// matches what the shelter game shows. Two sources of truth would
// drift; pulling the same constants the shelter uses keeps them lined
// up. Future: read from shelter-layout.json at runtime.
const SHELTER_CELL_W = 4
const SHELTER_CELL_H = 1.1
const SHELTER_CELL_D = ROOM_DEPTH
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
  // Camera state preserved across rebuilds — moving a prop bumps
  // structureKey and re-runs the scene effect, but the user's pan/zoom
  // /tilt frame should survive that.
  const cameraStateRef = useRef(null)
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

    // ORTHO camera matching the shelter's dollhouse render — same
    // tilt, same projection, so WYSIWYG between editor and game. Free
    // orbit is still available via ctrl+click (handler further below
    // applies a different camera frame on demand). Frustum height
    // chosen so a single cell + a bit of margin fills the viewport.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    // Position camera in front of the cell, tilt the scene world root
    // instead of the camera so the visible projection matches the
    // shelter exactly.
    const sceneRoot = new THREE.Group()
    sceneRoot.name = 'editor-scene-root'
    sceneRoot.rotation.x = SHELTER_TILT
    scene.add(sceneRoot)
    camera.position.set(0, SHELTER_CELL_H / 2, SHELTER_CELL_D * 1.5 + 2)
    camera.lookAt(0, SHELTER_CELL_H / 2, 0)
    const target = new THREE.Vector3(0, SHELTER_CELL_H / 2, 0)
    // Restore camera + tilt from prior mount if present so prop edits
    // (which rebuild the scene via structureKey) don't yank the view
    // back to defaults.
    if (cameraStateRef.current) {
      const s = cameraStateRef.current
      camera.position.set(s.pos.x, s.pos.y, s.pos.z)
      camera.zoom = s.zoom
      camera.updateProjectionMatrix()
      sceneRoot.rotation.set(s.tilt.x, s.tilt.y, s.tilt.z)
    }
    // Same controls as shelter (panZoomControls):
    //   plain drag → pan camera in XY
    //   wheel      → zoom toward cursor
    //   ctrl/cmd-drag → rotate sceneRoot (orbit around the cell)
    // Quick clicks (no-drag) still go to the raycaster for prop pick.
    const pan = interactive ? createPanZoomControls(camera, renderer.domElement, {
      minZoom: 0.4, maxZoom: 6,
      bounds: { minX: -SHELTER_CELL_W, maxX: SHELTER_CELL_W, minY: -SHELTER_CELL_H, maxY: SHELTER_CELL_H * 2 },
      onModifierDrag: (dx, dy) => {
        sceneRoot.rotation.y += dx * 0.006
        sceneRoot.rotation.x = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, sceneRoot.rotation.x + dy * 0.006))
      },
    }) : null
    function resizeOrtho() {
      const w = renderer.domElement.clientWidth
      const h = renderer.domElement.clientHeight
      const aspect = w / Math.max(h, 1)
      // Fit the whole cell (4 × 1.1) in the viewport with margin.
      // Frustum height needs to cover both cell height directly AND
      // cell width / aspect — pick the larger so neither axis clips.
      const margin = 1.2
      const frustumH = Math.max(SHELTER_CELL_H, SHELTER_CELL_W / aspect) * margin
      camera.left = -frustumH * aspect / 2
      camera.right = frustumH * aspect / 2
      camera.top = frustumH / 2
      camera.bottom = -frustumH / 2
      camera.updateProjectionMatrix()
    }
    resizeOrtho()

    // Build gray-box and stash refs for selection / GLB swap.
    let built = buildGrayBox(layout)
    // Render at shelter scale via TWO separate transforms — mirrors
    // exactly what ShelterStage3D + addLayoutDressing do, so a prop's
    // size/position relative to the room walls is identical in both
    // views:
    //   shellGroup    : anisotropic   → walls/ceiling stretch to fit
    //                   the dollhouse cell (4 × 1.1 × 3 m).
    //   dressingGroup : isotropic     → props keep correct w/h/d ratio,
    //                   so a 1.2 m desk in the layout doesn't reach
    //                   the side wall in either view.
    const dims = layout.dimensions || {}
    const sx = SHELTER_CELL_W / Math.max(dims.width || 1, 0.01)
    const sy = SHELTER_CELL_H / Math.max(dims.height || 1, 0.01)
    const sz = SHELTER_CELL_D / Math.max(dims.depth || 1, 0.01)
    const sIso = Math.min(sx, sy, sz)
    const shellGroup = new THREE.Group()
    shellGroup.name = 'shelter-cell-shell'
    shellGroup.scale.set(sx, sy, sz)
    shellGroup.add(built.group)
    sceneRoot.add(shellGroup)
    // Reparent every prop wrapper out of built.group into the dressing
    // group, which is at scene root with the isotropic scale. Layout-
    // local positions are preserved (group.add keeps the child's local
    // transform), so transform handles still operate on layout metres.
    const dressingGroup = new THREE.Group()
    dressingGroup.name = 'shelter-cell-dressing'
    dressingGroup.scale.setScalar(sIso)
    sceneRoot.add(dressingGroup)
    // Build a zone lookup so we can snap wall-attached props to the
    // cell interior the same way addLayoutDressing does in shelter.
    const zoneById = new Map(
      (layout.proposedProps || []).map((p) => [p.id, p.zone || null]),
    )
    const propsById = new Map((layout.props || []).map((p) => [p.id, p]))
    for (const [propId, wrapper] of built.props.entries()) {
      dressingGroup.add(wrapper)
      const prop = propsById.get(propId)
      const zone = zoneById.get(propId)
      if (!prop || !zone) continue
      // Editor's gray-box walls live OUTSIDE the layout volume (wallT=0
      // for the snap math); dressing is at world origin so there's no
      // dressingOriginY offset. Shelter uses different insets — that's
      // why the helper takes them as parameters.
      const snapped = wallSnapLocalPos({
        prop, zone,
        layoutHeight: layout.dimensions.height,
        cellW: SHELTER_CELL_W, cellH: SHELTER_CELL_H, cellDepth: SHELTER_CELL_D,
        wallT: 0, floorT: 0,
        dressingOriginY: 0, s: sIso,
      })
      if (snapped) wrapper.position.set(snapped.x, snapped.y, snapped.z)
    }
    // TEMP probe — exposes the dressing group so we can verify world
    // positions match the shelter render via the dev console.
    if (typeof window !== 'undefined') {
      window.__woidEditorProbe = { dressingGroup, shellGroup, sx, sy, sz, sIso }
    }
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
      // Pause pan/zoom while the gizmo owns the pointer so a handle
      // drag isn't double-handled as a camera pan.
      pan?.setEnabled?.(!e.value)
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
      if (dx > 5 || dy > 5 || dt > 400) return  // dragged or held — pan/orbit gesture
      // Ctrl/Cmd-click (without drag): snap the camera + sceneRoot tilt
      // back to the shelter-default frame. Ctrl/Cmd-drag is reserved by
      // panZoomControls for rotating the room, so a click-with-modifier
      // is the natural "reset" gesture.
      if (e.ctrlKey || e.metaKey) {
        camera.position.set(0, SHELTER_CELL_H / 2, SHELTER_CELL_D * 1.5 + 2)
        camera.zoom = 1
        camera.updateProjectionMatrix()
        sceneRoot.rotation.set(SHELTER_TILT, 0, 0)
        return
      }
      const rect = renderer.domElement.getBoundingClientRect()
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(ndc, camera)
      // Cast against everything under built.group; any hit's userData
      // chain lets us recover the propId we tagged in grayBoxBuilder.
      // Props live in dressingGroup now (reparented out of built.group
      // so they can iso-scale separately from the shell). Cast against
      // the dressing only — clicking the shell shouldn't select a prop.
      const hits = raycaster.intersectObjects(dressingGroup.children, true)
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
    // Floor plane is local y=0 inside sceneRoot. The ortho camera
    // looks along world -Z, so a world-space y=0 plane is parallel to
    // the ray and never hits — we have to raycast in sceneRoot local
    // space (which the tilt rotation lives in).
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const invSceneRoot = new THREE.Matrix4()
    const localRay = new THREE.Ray()
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
      sceneRoot.updateWorldMatrix(true, false)
      invSceneRoot.copy(sceneRoot.matrixWorld).invert()
      localRay.copy(raycaster.ray).applyMatrix4(invSceneRoot)
      const hit = new THREE.Vector3()
      const hitOk = localRay.intersectPlane(floorPlane, hit)
      if (!hitOk) return
      // Hit is in sceneRoot-local coords; dressingGroup iso-scales
      // children into the cell so invert by sIso to recover
      // layout-metres before clamping + saving.
      const lx = hit.x / sIso
      const lz = hit.z / sIso
      const halfW = (layout.dimensions.width || 1) / 2 - 0.3
      const halfD = (layout.dimensions.depth || 1) / 2 - 0.3
      onPropDrop?.({
        propId,
        position: {
          x: round3(Math.max(-halfW, Math.min(halfW, lx))),
          y: 0,
          z: round3(Math.max(-halfD, Math.min(halfD, lz))),
        },
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
        const propData = layout.props.find((p) => p.id === propId)
        if (!propData) continue
        // Prefer the prop's own asset; fall back to its source so
        // freshly-dropped duplicates display the original's GLB until
        // the user generates their own.
        let status = getAssetStatus(propId)
        if ((status?.status !== ROOM_ASSET_STATUS.ready || !status.modelUrl) && propData.sourceAssetId) {
          status = getAssetStatus(propData.sourceAssetId)
        }
        if (status?.status !== ROOM_ASSET_STATUS.ready || !status.modelUrl) continue
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
      /* panZoom updates on input */
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
      resizeOrtho()
    })
    ro.observe(container)

    return () => {
      running = false
      cameraStateRef.current = {
        pos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        zoom: camera.zoom,
        tilt: { x: sceneRoot.rotation.x, y: sceneRoot.rotation.y, z: sceneRoot.rotation.z },
      }
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
      pan?.dispose?.()
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

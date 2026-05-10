import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import config from '../config.js'

/**
 * Load a generated-room's layout from the bridge and add its prop GLBs
 * into a target THREE.Group, scaled anisotropically to fit shelter cell
 * dimensions (w × h × ROOM_DEPTH) instead of the layout's real-world
 * metres.
 *
 * Fire-and-forget: returns immediately. Each prop slot starts as a
 * faint placeholder box; when the GLB resolves we swap it in. Missing
 * GLBs simply leave the placeholder (so the room footprint is still
 * legible while assets generate).
 *
 * Used by ShelterStage3D.buildRoom() when a placed room has
 * `kind: 'generated'` and a `layoutId`.
 */

const BRIDGE_URL = config.agentSandbox?.bridgeUrl || ''

let _loader = null
function getLoader() {
  if (_loader) return _loader
  const draco = new DRACOLoader()
  draco.setDecoderPath('https://unpkg.com/three@0.184.0/examples/jsm/libs/draco/gltf/')
  _loader = new GLTFLoader().setDRACOLoader(draco)
  return _loader
}

const layoutCache = new Map() // layoutId → Promise<layout>
function fetchLayoutOnce(layoutId) {
  if (!BRIDGE_URL || !layoutId) return Promise.resolve(null)
  if (layoutCache.has(layoutId)) return layoutCache.get(layoutId)
  const p = fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(layoutId)}/layout`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j?.layout || null)
    .catch(() => null)
  layoutCache.set(layoutId, p)
  return p
}

/**
 * Apply the layout's prop dressing to the target group.
 *
 * @param {THREE.Group} group - room group from buildRoom()
 * @param {string} layoutId
 * @param {number} w - shelter cell width = gridW * cellW (metres in shelter scale)
 * @param {number} h - shelter cell height = gridH * cellH
 * @param {number} depth - shelter ROOM_DEPTH
 */
export function addLayoutDressing(group, layoutId, w, h, depth) {
  const dressing = new THREE.Group()
  dressing.name = `layout-dressing:${layoutId}`
  group.add(dressing)
  // Defer until the layout fetch resolves; meanwhile the room shell is
  // already rendered, so the cell looks empty but valid.
  fetchLayoutOnce(layoutId).then((layout) => {
    if (!layout?.props?.length) return
    const sx = w / Math.max(layout.dimensions.width, 0.01)
    const sy = h / Math.max(layout.dimensions.height, 0.01)
    const sz = depth / Math.max(layout.dimensions.depth, 0.01)
    dressing.scale.set(sx, sy, sz)
    // Centre vertically: shelter rooms have y=0 at vertical centre,
    // y in [-h/2, +h/2]. Layouts have y=0 at floor, y in [0, height].
    // Translate down so the layout's floor lines up with the cell's
    // floor (y = -h/2 / sy in pre-scale local space).
    dressing.position.y = -h / 2 / sy
    const loader = getLoader()
    for (const prop of layout.props) {
      const wrapper = new THREE.Group()
      wrapper.name = `prop:${prop.id}`
      wrapper.position.set(prop.position.x, prop.position.y, prop.position.z)
      wrapper.rotation.y = prop.rotation_y || 0
      dressing.add(wrapper)

      // Faint placeholder in case GLB never resolves (shows footprint).
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(prop.size.w, prop.size.h, prop.size.d),
        new THREE.MeshStandardMaterial({
          color: 0xa0a0a0, transparent: true, opacity: 0.18, depthWrite: false,
        }),
      )
      box.position.y = prop.size.h / 2
      box.userData.isPlaceholder = true
      wrapper.add(box)

      const url = `${BRIDGE_URL}/props/${encodeURIComponent(prop.id)}/model`
      loader.load(
        url,
        (gltf) => {
          const obj = gltf.scene
          obj.updateMatrixWorld(true)
          const bb = new THREE.Box3().setFromObject(obj)
          const sz2 = bb.getSize(new THREE.Vector3())
          obj.scale.x *= prop.size.w / Math.max(sz2.x, 0.001)
          obj.scale.y *= prop.size.h / Math.max(sz2.y, 0.001)
          obj.scale.z *= prop.size.d / Math.max(sz2.z, 0.001)
          obj.updateMatrixWorld(true)
          const after = new THREE.Box3().setFromObject(obj)
          obj.position.y -= after.min.y
          wrapper.add(obj)
          // Hide placeholder once GLB lands (kept around so toggling
          // visibility for debug works).
          box.visible = false
        },
        undefined,
        () => { /* GLB not generated yet — placeholder stays */ },
      )
    }
  })
}

/** Invalidate the cached layout so a refresh re-fetches. */
export function invalidateLayoutDressing(layoutId) {
  layoutCache.delete(layoutId)
}

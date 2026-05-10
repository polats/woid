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
// Active room groups keyed by layoutId so saveLayout-driven changes
// can repaint mounted shelter shells without a reload.
const activeGroups = new Map() // layoutId → Set<{ group, w, h, depth }>

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

function applyShellPalette(group, palette) {
  const mats = group.userData?.shellMaterials
  if (!mats || !palette) return
  if (palette.wall && mats.wall?.color) mats.wall.color.set(palette.wall)
  if (palette.floor && mats.floor?.color) mats.floor.color.set(palette.floor)
  if (palette.trim && mats.trim?.color) mats.trim.color.set(palette.trim)
  if (palette.ceiling && mats.ceiling?.color) mats.ceiling.color.set(palette.ceiling)
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
  // Track this mount so a saveLayout-driven repaint can find it.
  if (!activeGroups.has(layoutId)) activeGroups.set(layoutId, new Set())
  const entry = { group, w, h, depth }
  activeGroups.get(layoutId).add(entry)
  // Defer until the layout fetch resolves; meanwhile the room shell is
  // already rendered, so the cell looks empty but valid.
  fetchLayoutOnce(layoutId).then((layout) => {
    if (!layout) return
    applyShellPalette(group, layout.palette)
    if (!layout.props?.length) return
    // Iso-scale x and z together (preserves the floor-plan proportions
    // a desk's w/d ratio is real) by the smaller of the two fits, so
    // the room's footprint fills the shelter cell. y is scaled
    // independently to match the dollhouse's vertically-compressed
    // shell — props squash on y the same way the room itself does, so
    // the result looks consistent with the cell's aspect.
    const sx = w / Math.max(layout.dimensions.width, 0.01)
    const sy = h / Math.max(layout.dimensions.height, 0.01)
    const sz = depth / Math.max(layout.dimensions.depth, 0.01)
    const sFloor = Math.min(sx, sz)
    dressing.scale.set(sFloor, sy, sFloor)
    // Shelter rooms have y=0 at vertical centre, y in [-h/2, +h/2].
    // Layouts have y=0 at floor, y in [0, height]. Translate the
    // dressing origin down to the cell's floor so layout y=0 sits on
    // the shelter floor. Translation is in PARENT (group) space.
    dressing.position.y = -h / 2
    const loader = getLoader()
    // Tint placeholders with the room's accent so blank slots read as
    // belonging to the room (matches the room editor's gray-box style).
    // Falls back to a neutral mid-grey when the layout has no palette.
    const accentHex = layout.palette?.accent || '#a0a0a0'
    for (const prop of layout.props) {
      const wrapper = new THREE.Group()
      wrapper.name = `prop:${prop.id}`
      wrapper.position.set(prop.position.x, prop.position.y, prop.position.z)
      wrapper.rotation.y = prop.rotation_y || 0
      dressing.add(wrapper)

      // Solid-coloured placeholder in case GLB never resolves. Opacity
      // 0.55 (vs the editor's wireframe) so the cell reads as occupied
      // even at dollhouse scale where wireframes flicker.
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(prop.size.w, prop.size.h, prop.size.d),
        new THREE.MeshStandardMaterial({
          color: accentHex,
          roughness: 0.78, metalness: 0.04,
          transparent: true, opacity: 0.55,
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

/** Drop every cached layout — used by the shelter reset so any edits
 *  the user made in the rooms editor are picked up on the next render. */
export function invalidateAllLayoutDressing() {
  layoutCache.clear()
}

/**
 * Re-fetch the named layout and repaint every mounted shelter shell
 * that uses it. Called by saveLayout in roomLayoutStore so palette
 * changes in the rooms editor surface live in the shelter view.
 *
 * Currently only the shell palette is hot-swapped; prop dressing is
 * left in place (rebuilding GLBs would flicker the scene). A future
 * pass can also reconcile props if positions changed.
 */
export function refreshLayoutDressing(layoutId) {
  if (!layoutId) return
  layoutCache.delete(layoutId)
  const set = activeGroups.get(layoutId)
  if (!set || set.size === 0) return
  fetchLayoutOnce(layoutId).then((layout) => {
    if (!layout) return
    for (const { group } of set) applyShellPalette(group, layout.palette)
  })
}

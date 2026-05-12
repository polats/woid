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

/**
 * Compute the dressing-local position for a wall-attached prop so its
 * iso-scaled bbox edge touches the *interior* surface of the cell wall.
 *
 * Two views call this:
 *  - shelter cells, whose walls sit INSIDE the cell volume (wallT~5cm),
 *    so the visible inner wall surface is at ±cellW/2 ∓ wallT.
 *  - the rooms editor, whose gray-box walls are OUTSIDE the layout
 *    volume, so wallT/floorT = 0.
 *
 * The dressing group's own origin (`dressingOriginY`) and iso scale
 * (`s`) are folded in so the caller can use the returned position
 * verbatim on the wrapper.
 */
export function wallSnapLocalPos({
  prop, zone, layoutHeight,
  cellW, cellH, cellDepth,
  wallT = 0, floorT = 0,
  // World-Y of the visible floor surface. Shelter cells are centred on
  // y=0 so the floor sits at -cellH/2; the rooms editor's gray-box has
  // its floor at y=0. Defaulting preserves shelter behaviour.
  floorYWorld = -cellH / 2,
  dressingOriginY = 0, s = 1,
}) {
  if (!zone) return null
  const isBack = zone === 'back-wall-left' || zone === 'back-wall-center' || zone === 'back-wall-right'
  const isLeft = zone === 'side-wall-left'
  const isRight = zone === 'side-wall-right'
  const isCeiling = zone === 'ceiling-center'
  if (!isBack && !isLeft && !isRight && !isCeiling) return null
  let localX = prop.position.x
  let localY = prop.position.y
  let localZ = prop.position.z
  const thickness = prop.size.d * s
  if (isBack) {
    const worldZ = -cellDepth / 2 + wallT + thickness / 2
    localZ = worldZ / s
  } else if (isLeft) {
    const worldX = -cellW / 2 + wallT + thickness / 2
    localX = worldX / s
  } else if (isRight) {
    const worldX = cellW / 2 - wallT - thickness / 2
    localX = worldX / s
  } else if (isCeiling) {
    const worldY = floorYWorld + cellH - wallT - (prop.size.h * s) / 2
    localY = (worldY - dressingOriginY) / s
    return { x: localX, y: localY, z: localZ }
  }
  // Wall props: map layout-y fraction onto the cell's interior y range
  // so eye-level art lands mid-cell instead of near the floor.
  const layoutH = Math.max(layoutHeight || 1, 0.01)
  const interiorFloor = floorYWorld + floorT
  const interiorCeil = floorYWorld + cellH - wallT
  const interiorRange = interiorCeil - interiorFloor
  const yFrac = Math.max(0, Math.min(1, prop.position.y / layoutH))
  const worldY = interiorFloor + yFrac * interiorRange
  localY = (worldY - dressingOriginY) / s
  return { x: localX, y: localY, z: localZ }
}

function applyShellPalette(group, palette) {
  const mats = group.userData?.shellMaterials
  if (palette && mats) {
    if (palette.wall && mats.wall?.color) mats.wall.color.set(palette.wall)
    if (palette.floor && mats.floor?.color) mats.floor.color.set(palette.floor)
    if (palette.trim && mats.trim?.color) mats.trim.color.set(palette.trim)
    if (palette.ceiling && mats.ceiling?.color) mats.ceiling.color.set(palette.ceiling)
  }
  // Architectural floor texture is canvas-baked from the palette, so a
  // colour change requires redrawing it. Lazy-imported to keep this
  // module independent of the visual layer in tests.
  if (palette && group.userData?.architecturalFloor) {
    import('./architecturalDetails.js')
      .then((m) => m.repaintArchitecturalFloor?.(group, palette))
      .catch(() => { /* optional */ })
  }
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
    // Re-run the architectural pass with the bridge layout's overrides
    // (architecture.trim / ceiling / floor + final palette). Rebuilds
    // trim meshes + canvas floor + ceiling grid in place.
    if (layout.architecture && group.userData?.rebuildArchitecture) {
      try {
        group.userData.rebuildArchitecture({
          architecture: layout.architecture,
          palette: layout.palette,
        })
      } catch (err) {
        console.warn('[layout-dressing] rebuildArchitecture failed:', err)
      }
    }
    if (!layout.props?.length) return
    // Isotropic size scale so props read at consistent w/h/d ratios.
    // Iso alone leaves wall-attached props "floating" inside the cell
    // because layout x=-W/2 maps to world x=-W/2 * s, not -cell/2.
    // Below, wall-zoned wrappers get their position overridden so
    // their iso-scaled bbox edge touches the cell wall.
    const sx = w / Math.max(layout.dimensions.width, 0.01)
    const sy = h / Math.max(layout.dimensions.height, 0.01)
    const sz = depth / Math.max(layout.dimensions.depth, 0.01)
    const s = Math.min(sx, sy, sz)
    dressing.scale.set(s, s, s)
    // TEMP probe — register every dressing on a global so the test
    // harness can compare prop world positions against the editor.
    if (typeof window !== 'undefined') {
      window.__woidShelterProbe ??= {}
      window.__woidShelterProbe[layoutId] = { dressing, sx, sy, sz, s }
    }
    // Lookup zones from proposedProps so the wrapper code below can
    // recognise wall-attached props and snap their wrapper position
    // to the cell wall regardless of layout dimensions.
    const zoneById = new Map(
      (layout.proposedProps || []).map((p) => [p.id, p.zone || null]),
    )
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
      // Snap wall-attached props to the cell interior so they don't
      // float / sink. wallT/floorT are the shelter cell's mesh
      // thicknesses (walls live inside the cell volume here, unlike
      // the gray-box editor where they sit outside).
      const snapped = wallSnapLocalPos({
        prop, zone: zoneById.get(prop.id),
        layoutHeight: layout.dimensions.height,
        cellW: w, cellH: h, cellDepth: depth,
        wallT: 0.05, floorT: 0.08,
        dressingOriginY: -h / 2, s,
      })
      const pos = snapped ?? prop.position
      wrapper.position.set(pos.x, pos.y, pos.z)
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

      const tryUrls = [prop.id]
      // Duplicates inherit their source asset until they get their own
      // generation — try the prop's own GLB first, fall back to source.
      if (prop.sourceAssetId && prop.sourceAssetId !== prop.id) tryUrls.push(prop.sourceAssetId)
      const onLoaded = (gltf) => {
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
        box.visible = false
      }
      const loadNext = (idx) => {
        if (idx >= tryUrls.length) return
        loader.load(
          `${BRIDGE_URL}/props/${encodeURIComponent(tryUrls[idx])}/model`,
          onLoaded,
          undefined,
          () => loadNext(idx + 1),
        )
      }
      loadNext(0)
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
    for (const { group } of set) {
      applyShellPalette(group, layout.palette)
      // Re-run the architectural pass on the saved layout so trim /
      // ceiling / floor overrides surface in shelter immediately
      // after saveLayout — not only on the next page load.
      if (group.userData?.rebuildArchitecture) {
        try {
          group.userData.rebuildArchitecture({
            architecture: layout.architecture || {},
            palette: layout.palette,
          })
        } catch (err) {
          console.warn('[layout-dressing] rebuildArchitecture failed:', err)
        }
      }
    }
  })
}

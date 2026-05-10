/**
 * Off-screen multi-angle capture of a room's gray-box scene. Renders
 * the same shell + prop boxes the live preview shows, but from a fixed
 * set of camera positions, with cutaway walls per angle so each shot
 * reveals the interior.
 *
 * Output: an array of `{ angle, dataUri, w, h }` PNG snapshots that the
 * mocks pipeline ships to FLUX-Kontext alongside the prop list.
 *
 * Now consumes a layout JSON via roomLayoutStore — the same source of
 * truth as the live preview, so the references match what the user
 * sees in the drawer.
 */

import * as THREE from 'three'
import { buildGrayBox, applyCutaway, frameCamera } from './grayBoxBuilder.js'
import { fetchLayout, getLayout, ROOM_LAYOUT_STATUS } from './roomLayoutStore.js'

/** Camera presets — angle name + position offset bias + lookAt target. */
export const ANGLES = [
  { id: 'front', biasX: 0,   biasY: 1.0, biasZ: 1.4, hint: 'centred, looking in' },
  { id: 'iso-l', biasX: -1,  biasY: 0.9, biasZ: 1.0, hint: 'cut left wall' },
  { id: 'iso-r', biasX: 1,   biasY: 0.9, biasZ: 1.0, hint: 'cut right wall' },
  { id: 'top',   biasX: 0,   biasY: 1.6, biasZ: 0.4, hint: 'cut ceiling' },
]

/**
 * Render the room from each angle. `roomId` triggers a layout fetch if
 * it isn't already cached. Returns Promise<Array<{angle, dataUri, w, h}>>.
 */
export async function captureRoomMocks(roomId, { width = 768, height = 768 } = {}) {
  let entry = getLayout(roomId)
  if (entry?.status !== ROOM_LAYOUT_STATUS.ready) {
    await fetchLayout(roomId)
    entry = getLayout(roomId)
  }
  const layout = entry?.layout
  if (!layout) {
    throw new Error(`captureRoomMocks: no layout for ${roomId} (${entry?.status || 'idle'})`)
  }

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  })
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(layout.palette.ceiling || '#e8e4d8')
  scene.add(new THREE.AmbientLight(0xffffff, 0.35))

  const built = buildGrayBox(layout)
  scene.add(built.group)

  // Use the same suggested framing as the live preview so the mockup
  // refs feel like the room you saw on screen.
  const { position: basePos, target } = frameCamera(layout)
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.05, 200)

  const dist = basePos.distanceTo(target)
  const out = []
  for (const angle of ANGLES) {
    applyCutaway(built.shell, angle.id)
    // Compose this angle's camera position by biasing the framed
    // distance along the requested axes. iso-l/iso-r flip x, top
    // pulls high, front nudges back to centre.
    camera.position.set(
      angle.biasX * dist * 0.55,
      target.y + angle.biasY * dist * 0.45,
      angle.biasZ * dist * 0.55,
    )
    camera.lookAt(target)
    renderer.render(scene, camera)
    const dataUri = renderer.domElement.toDataURL('image/png')
    out.push({ angle: angle.id, dataUri, w: width, h: height })
  }

  // Cleanup
  built.group.traverse((o) => {
    o.geometry?.dispose?.()
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.())
    else o.material?.dispose?.()
  })
  renderer.dispose()
  return out
}

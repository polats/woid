import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import config from '../config.js'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { useShelterTick } from '../hooks/useShelterTick.js'
import { WALK_DURATION_MIN, PACE_DURATION_MIN } from '../lib/shelterStore/index.js'
import { createPanZoomControls } from '../lib/panZoomControls.js'
import { buildDressing, ROOM_DEPTH } from '../lib/shelterDressing.js'
import {
  animationLibrary,
  createCharacterRegistry,
  createAvatarFactory,
  createPresenceProjector,
} from '../lib/shelterWorld/index.js'
import { registerStageHandler } from '../lib/shelterStageBus.js'

/**
 * Shelter diorama renderer.
 *
 * Single shared canvas + ortho camera. Reads /shelter-layout.json and
 * builds one THREE.Group per room (3D shell + dressing + warm point
 * light), parented to a tilted world root. Pan/zoom via
 * panZoomControls; double-tap a room to focus it with a smooth
 * camera tween.
 *
 * See docs/design/shelter-view.md.
 */
const FRUSTUM_HEIGHT = 4
const PAN_MARGIN = 1
const TILT_MAX = 0.15  // rad — full dollhouse tilt at min zoom

// Named camera framings used by the tutorial runtime so scripts.json
// can reference 'room' / 'home' / 'closeup' instead of hand-tuned zoom
// numbers. Closeup is driven by the focused agent's bbox (see
// focusCharacter); the other two are room-level / home-level frames
// computed at scene setup.
export const CAMERA_STATE = Object.freeze({
  HOME: 'home',
  ROOM: 'room',
  CLOSEUP: 'closeup',
})
const TILT_MIN = 0.04  // rad — flatter when zoomed into a single room
const FOCUS_TWEEN_MS = 420
const DOUBLE_TAP_MS = 320
const TAP_PIXEL_TOLERANCE = 6

// Per-category warm/cool tone for the room's pendant lamp. Drives both
// the visible bulb material and the PointLight colour so the glow
// matches the bulb.
const LAMP_COLORS = {
  surface: 0xffd9a8,
  living: 0xffd9a8,
  office: 0xcfeae0,
  'break-room': 0xffb88a,
  wellness: 0xe0c8ff,
}

function makeLabelSprite(text) {
  const PAD = 8
  const FONT = '600 32px system-ui, sans-serif'
  const measure = document.createElement('canvas').getContext('2d')
  measure.font = FONT
  const w = Math.ceil(measure.measureText(text).width) + PAD * 2
  const h = 40 + PAD * 2
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#ffffff'
  ctx.font = FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, h / 2 + 2)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
  const worldH = 0.32
  const worldW = worldH * (w / h)
  sprite.scale.set(worldW, worldH, 1)
  return sprite
}

function buildShell(w, h, color) {
  const g = new THREE.Group()
  const D = ROOM_DEPTH
  const wallT = 0.05
  const floorT = 0.08
  const base = new THREE.Color(color || '#555555')
  const dark = base.clone().multiplyScalar(0.55)
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0, roughness: 0.85 })

  const add = (geom, material, x, y, z) => {
    const m = new THREE.Mesh(geom, material)
    m.position.set(x, y, z)
    g.add(m)
  }
  add(new THREE.BoxGeometry(w, floorT, D), mat(dark.getHex()), 0, -h / 2 + floorT / 2, 0)
  add(new THREE.BoxGeometry(w, wallT, D), mat(dark.getHex()), 0, h / 2 - wallT / 2, 0)
  add(new THREE.BoxGeometry(w, h, wallT), mat(base.getHex()), 0, 0, -D / 2 + wallT / 2)
  add(new THREE.BoxGeometry(wallT, h, D), mat(dark.getHex()), -w / 2 + wallT / 2, 0, 0)
  add(new THREE.BoxGeometry(wallT, h, D), mat(dark.getHex()), w / 2 - wallT / 2, 0, 0)
  return g
}

/**
 * Add all decorative geometry inside a room — category dressing
 * (bunks, desks, plants, etc.) and the visible pendant lamp
 * fixture (cord + housing + bulb pad). The PointLight that
 * illuminates the room stays outside this helper so the room is
 * still lit when furniture is hidden.
 */
function addRoomFurniture(group, category, w, h, lampColor) {
  group.add(buildDressing(category, w, h))

  const housingY = h / 2 - 0.27
  const fixtureZ = 0.12
  const cord = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.18, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x101418 }),
  )
  cord.position.set(0, h / 2 - 0.13, fixtureZ)
  group.add(cord)
  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.06, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x202830 }),
  )
  housing.position.set(0, housingY, fixtureZ)
  group.add(housing)
  const bulb = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16, 0.16),
    new THREE.MeshBasicMaterial({ color: lampColor }),
  )
  bulb.rotation.x = -Math.PI / 2
  bulb.position.set(0, housingY - 0.031, fixtureZ)
  group.add(bulb)
}

function buildRoom(room, cellW, cellH) {
  const group = new THREE.Group()
  group.name = `room:${room.id}`
  const w = room.gridW * cellW
  const h = room.gridH * cellH
  const cx = (room.gridX + room.gridW / 2) * cellW
  const cy = (room.gridY + room.gridH / 2) * cellH
  group.position.set(cx, cy, 0)
  // Stash room metadata so click handlers can recover it from raycast hits.
  group.userData.room = { id: room.id, name: room.name, w, h, cx, cy }

  group.add(buildShell(w, h, room.color))

  const lampColor = LAMP_COLORS[room.category] ?? 0xffd9a8
  // Furniture temporarily disabled so agents stand out clearly while
  // we iterate on the behaviour layer. Re-enable to bring back bunks,
  // desks, plants, and the visible pendant fixture.
  // addRoomFurniture(group, room.category, w, h, lampColor)

  // Room point light — kept outside addRoomFurniture so the room
  // stays lit even when furniture is hidden.
  const housingY = h / 2 - 0.27
  const lamp = new THREE.PointLight(lampColor, 1.1, ROOM_DEPTH * 1.3, 1.6)
  lamp.position.set(0, housingY - 0.05, 0.12)
  group.add(lamp)

  const label = makeLabelSprite(room.name)
  label.position.set(-w / 2 + 0.45, h / 2 - 0.18, ROOM_DEPTH / 2 + 0.02)
  group.add(label)

  return group
}

function computeBounds(rooms, cellW, cellH) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const r of rooms) {
    minX = Math.min(minX, r.gridX * cellW)
    maxX = Math.max(maxX, (r.gridX + r.gridW) * cellW)
    minY = Math.min(minY, r.gridY * cellH)
    maxY = Math.max(maxY, (r.gridY + r.gridH) * cellH)
  }
  return {
    minX: minX - PAN_MARGIN,
    maxX: maxX + PAN_MARGIN,
    minY: minY - PAN_MARGIN,
    maxY: maxY + PAN_MARGIN,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  }
}

const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export default function ShelterStage3D({ onFocusChange = null, onAgentFocusChange = null } = {}) {
  const hostRef = useRef(null)
  const onFocusChangeRef = useRef(onFocusChange)
  useEffect(() => { onFocusChangeRef.current = onFocusChange }, [onFocusChange])
  const onAgentFocusChangeRef = useRef(onAgentFocusChange)
  useEffect(() => { onAgentFocusChangeRef.current = onAgentFocusChange }, [onAgentFocusChange])

  // Engine handles to live longer than the main effect's closure so a
  // sibling presence-sync effect can spawn / despawn / reposition
  // avatars without re-running scene setup.
  const factoryRef = useRef(null)
  const projectorRef = useRef(null)
  const worldRootRef = useRef(null)
  const liveAvatarsRef = useRef(new Map())  // npub → spawn handle
  // Agent-focus state lives in refs so both the setup effect (which
  // owns the click handler + per-frame face-camera) and the sync
  // effect (which despawns avatars) can read/write it.
  const focusedAgentIdRef = useRef(null)
  const focusedAgentRestoreRef = useRef(null)
  // Bumped when the registry signals a model change for a visible
  // npub — forces the sync effect to re-run and respawn that agent.
  const invalidationRef = useRef(0)
  const [presenceTick, setPresenceTick] = useState(0)

  // Local-first state — ShelterStore in localStorage drives the
  // agent set. The colyseus sandbox is no longer the source of truth
  // for Shelter; Sims still uses it. See shelter-agents.md.
  const cfg = config.agentSandbox || {}
  useShelterTick()
  const shelterSnapshot = useShelterStore()
  // Direct store handle — captured by the render loop so it can read
  // a fresh snapshot every frame for walk-tween interpolation, without
  // re-subscribing through React's render cycle.
  const shelterStore = useShelterStoreApi()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.touchAction = 'none'

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x202327)

    // PBR environment lighting — same setup as the Sims stage.
    // The PMREM-baked RoomEnvironment carries the diffuse + specular
    // ambient; per-room point lights still add warm interior glow.
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.6

    const worldRoot = new THREE.Group()
    worldRoot.name = 'shelter:world'
    worldRoot.rotation.x = TILT_MAX
    scene.add(worldRoot)

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)

    let layoutBounds = null  // set by the fetch handler below
    const resize = () => {
      const w = host.clientWidth || 1
      const h = host.clientHeight || 1
      renderer.setSize(w, h, false)
      const aspect = w / h
      const halfH = FRUSTUM_HEIGHT / 2
      const halfW = halfH * aspect
      camera.left = -halfW
      camera.right = halfW
      camera.top = halfH
      camera.bottom = -halfH
      camera.updateProjectionMatrix()
      refit(false)
    }

    // Recompute the home frame so the diorama's bbox fits the viewport
    // with a small margin. Always update homeFrame + zoom limits; only
    // snap the camera if `snap` is true (used on initial layout load).
    const refit = (snap) => {
      if (!layoutBounds) return
      const ww = host.clientWidth || 1
      const hh = host.clientHeight || 1
      const aspect = ww / hh
      const visH = FRUSTUM_HEIGHT
      const visW = FRUSTUM_HEIGHT * aspect
      const FIT_MARGIN = 0.9
      const fitZoom = Math.min(visH / layoutBounds.height, visW / layoutBounds.width) * FIT_MARGIN
      homeFrame = { centerX: layoutBounds.centerX, centerY: layoutBounds.centerY, zoom: fitZoom }
      // Allow the user to pull out at least as far as the home frame.
      controls.setLimits({ minZoom: Math.min(0.3, fitZoom * 0.95), maxZoom: 8 })
      if (snap) {
        camera.position.set(homeFrame.centerX, homeFrame.centerY, 10)
        camera.zoom = homeFrame.zoom
        camera.updateProjectionMatrix()
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    // Camera focus tween — written by double-tap, cancelled by any
    // user pan/zoom input. While `tween.active`, the render loop
    // overwrites camera.zoom and camera.position each frame. `onDone`
    // applies/clears the lock state when the tween completes.
    const tween = {
      active: false, t0: 0, dur: 0,
      fz: 1, tz: 1, fx: 0, fy: 0, tx: 0, ty: 0,
      onDone: null,
    }
    let focusedRoomId = null
    let focusedRoomMeta = null
    let homeFrame = null  // { centerX, centerY, zoom }
    let homeBounds = null
    // Agent-focus state. Independent of room focus, but room focus
    // is also driven for the agent's current room when focusing.
    // Mirrored from refs (`focusedAgentIdRef`, `focusedAgentRestoreRef`)
    // so the despawn handler in the sync effect can also read/clear them.

    // Build a yellow silhouette by adding a sibling/child mesh per host
    // mesh: same geometry, BackSide rendering, vertices pushed along
    // their normal by a shader-uniform thickness so we can pulse it
    // per-frame. Original materials are never touched; outline meshes
    // set castShadow=false so shadows stay clean.
    const HIGHLIGHT_BASE = new THREE.Color(0xe61a3a)  // saturated crimson — pops against paper/wood backgrounds
    const HIGHLIGHT_PEAK = new THREE.Color(0xff7080)  // lighter pink-red peak
    const OUTLINE_THICKNESS_MIN = 0.022
    const OUTLINE_THICKNESS_MAX = 0.034
    const PULSE_PERIOD_SEC = 2.2
    // Reused per-frame to avoid GC churn while the focus stays on.
    const _faceCamMat = new THREE.Matrix4()
    const _faceCamVec = new THREE.Vector3()
    const _pulseColor = new THREE.Color()
    // Materials currently driving the focused agent's outline; pulsed
    // each frame from the render tick.
    let pulseTargets = []

    const applyOutline = (object3d) => {
      const added = []
      const targets = []
      // Collect first; appending children during traverse can re-enter.
      const hosts = []
      object3d.traverse((o) => {
        if ((o.isSkinnedMesh || o.isMesh) && !o.userData.__isOutline) {
          hosts.push(o)
        }
      })
      for (const host of hosts) {
        const mat = new THREE.MeshBasicMaterial({
          color: HIGHLIGHT_BASE.clone(),
          side: THREE.BackSide,
          fog: false,
        })
        // Shader uniform `uThickness` so we can pulse thickness per
        // frame without recompiling. mat.userData.uThickness is the
        // canonical reference the render tick writes to.
        mat.userData.uThickness = { value: OUTLINE_THICKNESS_MIN }
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uThickness = mat.userData.uThickness
          shader.vertexShader = shader.vertexShader
            .replace(
              '#include <common>',
              '#include <common>\nuniform float uThickness;',
            )
            .replace(
              '#include <begin_vertex>',
              '#include <begin_vertex>\n        transformed += normal * uThickness;',
            )
        }
        let outline
        if (host.isSkinnedMesh) {
          outline = new THREE.SkinnedMesh(host.geometry, mat)
          outline.bind(host.skeleton, host.bindMatrix)
        } else {
          outline = new THREE.Mesh(host.geometry, mat)
        }
        outline.userData.__isOutline = true
        outline.frustumCulled = false
        outline.castShadow = false
        outline.receiveShadow = false
        host.add(outline)
        added.push({ outline, host })
        targets.push(mat)
      }
      pulseTargets = targets
      return () => {
        // Stop driving the now-stale materials before disposal.
        if (pulseTargets === targets) pulseTargets = []
        for (const { outline, host } of added) {
          host.remove(outline)
          try { outline.material.dispose() } catch {}
        }
      }
    }

    // Centralised focus-state setter — keeps focusedRoomId, the
    // pan-zoom lock, the bounds, and the parent-facing onFocusChange
    // callback in sync.
    const applyFocus = (roomGroup) => {
      if (roomGroup) {
        const meta = roomGroup.userData.room
        focusedRoomId = meta.id
        focusedRoomMeta = meta
        // Clamp horizontal pan to the focused room so cropped edges
        // are reachable but neighbours aren't.
        const visW = (camera.right - camera.left) / camera.zoom
        const halfVis = visW / 2
        let xMin = meta.cx - meta.w / 2 + halfVis
        let xMax = meta.cx + meta.w / 2 - halfVis
        if (xMin > xMax) { xMin = xMax = meta.cx }
        controls.setBounds({ minX: xMin, maxX: xMax, minY: meta.cy, maxY: meta.cy })
        controls.setLock({ y: meta.cy, zoom: true, onExit: exitFocus })
        onFocusChangeRef.current?.({ id: meta.id, name: meta.name })
      } else {
        focusedRoomId = null
        focusedRoomMeta = null
        controls.setLock({})
        if (homeBounds) controls.setBounds(homeBounds)
        onFocusChangeRef.current?.(null)
      }
    }

    const exitFocus = () => {
      // Always clear agent focus alongside room focus — both are user-
      // visible "selection" state and the agent highlight should never
      // outlive the room zoom that framed it.
      if (focusedAgentRestoreRef.current) {
        try { focusedAgentRestoreRef.current() } catch {}
      }
      focusedAgentRestoreRef.current = null
      // Force the previously-focused agent's currentRole to null so the
      // role swap on the next sync tick re-resolves to walk / idle /
      // resting, instead of sticking on 'wave'.
      const prevFocusId = focusedAgentIdRef.current
      if (prevFocusId) {
        const prevHandle = liveAvatarsRef.current.get(prevFocusId)
        if (prevHandle) {
          prevHandle.currentRole = null
          prevHandle.focusRole = null
        }
      }
      focusedAgentIdRef.current = null
      onAgentFocusChangeRef.current?.(null)
      if (!focusedRoomId || !homeFrame) return
      const fx = camera.position.x
      const fy = camera.position.y
      const fz = camera.zoom
      // Clear focus state up-front so the HUD hides instantly and any
      // wheel events arriving during the tween don't see a focused
      // room and try to re-trigger exitFocus / cancel the tween.
      applyFocus(null)
      tween.active = true
      tween.t0 = performance.now()
      tween.dur = FOCUS_TWEEN_MS
      tween.fx = fx
      tween.fy = fy
      tween.fz = fz
      tween.tx = homeFrame.centerX
      tween.ty = homeFrame.centerY
      tween.tz = homeFrame.zoom
      tween.onDone = null
    }

    // Character-focus reuses the room-focus Y centre (meta.cy) so the
    // vertical framing matches double-tap-room exactly — characters
    // can't be "too high" or "too low" in frame, because rooms are
    // already framed to fit. Only the X shifts to follow the
    // character. If the agent has no resolvable room we fall back to
    // an approximate mid-body Y.
    const CHARACTER_FALLBACK_Y_OFFSET = 0.5

    // Tween the camera to a specific character's world position, then
    // lock pan to their containing room (if known). Used by tap-to-
    // focus so the avatar stays framed even if the room's centre would
    // have left them off-screen — characters drift to room edges as
    // they pace, and the room-cover framing can crop them out.
    const focusCharacter = (handle, agent, opts = {}) => {
      if (!handle || !handle.object3d) return
      const wrapper = handle.object3d
      // Match the zoom AND vertical centre of the room-focus path,
      // shifting only the horizontal centre to follow the character.
      // Without a resolvable room, fall back to a manual mid-body Y.
      const rgForZoom = roomGroupForAgent(agent)
      let toZoom = 3
      let ty = wrapper.position.y + CHARACTER_FALLBACK_Y_OFFSET
      if (opts.closeup) {
        // Cinematic closeup: tight framing where the character takes
        // up most of the screen — feet crop at the bottom, head fits
        // at the top. Uses the world-space bbox of the avatar so it's
        // proportional even when the rig is mid-animation. Visible
        // height is < charH so the character overflows the frame; the
        // center is shifted upward so the crop falls on the feet.
        const box = new THREE.Box3().setFromObject(wrapper)
        const charH = Math.max(0.4, box.max.y - box.min.y)
        const charCenterY = (box.max.y + box.min.y) / 2
        const desiredVisibleH = charH * 0.85   // shows ~85% of body
        toZoom = Math.min(8, FRUSTUM_HEIGHT / desiredVisibleH)
        ty = charCenterY + charH * 0.075       // shift up → feet crop
      } else if (rgForZoom) {
        const aspect = (renderer.domElement.clientWidth || 1) / (renderer.domElement.clientHeight || 1)
        const meta = rgForZoom.userData.room
        const zoomByH = FRUSTUM_HEIGHT / meta.h
        const zoomByW = (FRUSTUM_HEIGHT * aspect) / meta.w
        toZoom = Math.min(Math.max(zoomByH, zoomByW), 8)
        ty = meta.cy
      }
      const tx = wrapper.position.x
      controls.setLock({})
      tween.active = true
      tween.t0 = performance.now()
      tween.dur = FOCUS_TWEEN_MS
      tween.fx = camera.position.x
      tween.fy = camera.position.y
      tween.fz = camera.zoom
      tween.tx = tx
      tween.ty = ty
      tween.tz = toZoom
      tween.onDone = () => {
        // Cinematic closeup pins the camera completely — no drift, no
        // user-driven pan — so the framing the tutorial set up holds.
        if (opts.closeup) {
          controls.setBounds({ minX: tx, maxX: tx, minY: ty, maxY: ty })
          controls.setLock({ y: ty, zoom: true, onExit: exitFocus })
          return
        }
        // Lock pan to the room bounds (so the user can drag laterally
        // within the room) but keep the lock's Y at the character's
        // head height — that's the settled centre.
        const rg = roomGroupForAgent(agent)
        if (!rg) return
        const meta = rg.userData.room
        const visW = (camera.right - camera.left) / camera.zoom
        const halfVis = visW / 2
        let xMin = meta.cx - meta.w / 2 + halfVis
        let xMax = meta.cx + meta.w / 2 - halfVis
        if (xMin > xMax) { xMin = xMax = meta.cx }
        controls.setBounds({ minX: xMin, maxX: xMax, minY: ty, maxY: ty })
        controls.setLock({ y: ty, zoom: true, onExit: exitFocus })
        focusedRoomId = meta.id
        focusedRoomMeta = meta
        onFocusChangeRef.current?.({ id: meta.id, name: meta.name })
      }
    }

    // Run the same camera tween + lock that double-tap-room uses, but
    // for an arbitrary roomGroup. Extracted so agent-tap can drive the
    // same focus path. Idempotent if `roomGroup` is already focused.
    const focusRoom = (roomGroup) => {
      if (!roomGroup) return
      if (focusedRoomId === roomGroup.userData.room?.id) return
      const aspect = (renderer.domElement.clientWidth || 1) / (renderer.domElement.clientHeight || 1)
      const meta = roomGroup.userData.room
      const zoomByH = FRUSTUM_HEIGHT / meta.h
      const zoomByW = (FRUSTUM_HEIGHT * aspect) / meta.w
      const toZoom = Math.min(Math.max(zoomByH, zoomByW), 8)
      controls.setLock({})
      tween.active = true
      tween.t0 = performance.now()
      tween.dur = FOCUS_TWEEN_MS
      tween.fx = camera.position.x
      tween.fy = camera.position.y
      tween.fz = camera.zoom
      tween.tx = meta.cx
      tween.ty = meta.cy
      tween.tz = toZoom
      tween.onDone = () => applyFocus(roomGroup)
    }

    // Lookup the roomGroup for an agent — uses pos.roomId when settled
    // or assignment.roomId when walking. Returns null if neither maps
    // to a known room (e.g. fresh agent, untracked room).
    const roomGroupForAgent = (agent) => {
      const roomId = agent?.pos?.roomId ?? agent?.assignment?.roomId
      if (!roomId) return null
      return roomGroups.find((g) => g.userData.room?.id === roomId) ?? null
    }

    // opts:
    //   outline    — apply the red selection outline (default true)
    //   motionRole — role tag to play immediately, or null to skip
    //                (default 'wave'; tutorial cinematic passes e.g.
    //                'arms-crossed')
    //   closeup    — tighter cinematic framing (default false)
    const focusAgent = (agentId, opts = {}) => {
      const useOutline = opts.outline !== false
      const motionRole = opts.motionRole === undefined ? 'wave' : opts.motionRole
      const handle = liveAvatarsRef.current.get(agentId)
      if (!handle || handle.pending || !handle.object3d) return
      // Switching from another agent: restore the previous outline
      // and reset its currentRole so the next sync tick re-resolves
      // it to whatever the FSM wants (idle / walk / resting).
      if (focusedAgentRestoreRef.current) {
        try { focusedAgentRestoreRef.current() } catch {}
      }
      const prevFocusId = focusedAgentIdRef.current
      if (prevFocusId && prevFocusId !== agentId) {
        const prevHandle = liveAvatarsRef.current.get(prevFocusId)
        if (prevHandle) {
          prevHandle.currentRole = null
          prevHandle.focusRole = null
        }
      }
      focusedAgentIdRef.current = agentId
      focusedAgentRestoreRef.current = useOutline ? applyOutline(handle.object3d) : null
      // Notify the parent so it can render the character card. Look up
      // profile fields (name, avatarUrl) from the character registry,
      // falling back to the agent's stored name and the bridge fallback
      // URL when the registry hasn't populated this entry yet.
      const agentRecord = shelterStore.getSnapshot().agents?.[agentId]
      const reg = agentRecord?.pubkey ? registry.get(agentRecord.pubkey) : null
      onAgentFocusChangeRef.current?.({
        id: agentId,
        pubkey: agentRecord?.pubkey ?? null,
        name: reg?.name ?? agentRecord?.name ?? null,
        avatarUrl: reg?.avatarUrl ?? null,
      })
      // Force-play `motionRole` immediately so the focus has visible
      // feedback before the next per-snapshot role swap. Only kimodo-
      // tier avatars expose setMotion; static / fallback animators
      // (e.g. NPCs without a kimodo rig like Edi) get no role swap —
      // they hold whatever default motion the fallback path assigned.
      // Stash the focus motion on the handle so the per-frame sync
      // loop respects it instead of hardcoding 'wave' — without this,
      // the next snapshot tick swaps the motion back to wave.
      handle.focusRole = motionRole ?? null
      if (motionRole && typeof handle.animator?.setMotion === 'function') {
        const motionId = animationLibrary.getRoleId(motionRole)
        const cached = motionId ? animationLibrary.peek(motionId) : null
        if (cached) {
          handle.animator.setMotion(cached, { loop: true, applyRootTranslation: false })
          handle.currentRole = motionRole
        } else {
          handle.currentRole = motionRole // optimistic
          animationLibrary.getRole(motionRole).then((m) => {
            if (m && typeof handle.animator?.setMotion === 'function'
                && focusedAgentIdRef.current === agentId) {
              handle.animator.setMotion(m, { loop: true, applyRootTranslation: false })
            }
          }).catch(() => {})
        }
      }
      // Camera focus on the character itself, not the room — characters
      // can pace to room edges and the room-cover framing then crops
      // them out. focusCharacter still locks pan to the room so the
      // user can drag around afterward.
      const agent = shelterStore.getSnapshot().agents?.[agentId]
      focusCharacter(handle, agent, { closeup: !!opts.closeup })
    }

    // Outside callers (currently the tutorial runtime) drive focus
    // through this bus. Registered here so the closure has access to
    // the live focusAgent/exitFocus closures.
    // Tutorial cinematic helpers — animate wrapper positions /
    // override motion / pan the camera. All keep working closures
    // off the live setup so they have access to camera, controls,
    // tween, and liveAvatarsRef without re-resolving.
    const animateAgentWalk = (pubkey, dx, dy, ms, opts = {}) => {
      const agentRecord = Object.values(shelterStore.getSnapshot().agents ?? {})
        .find((a) => a.pubkey === pubkey)
      if (!agentRecord) return Promise.resolve()
      const handle = liveAvatarsRef.current.get(agentRecord.id)
      if (!handle || !handle.object3d) return Promise.resolve()
      handle.tutorialRole = 'walk'
      // Force-swap to walk motion right now so the avatar doesn't
      // slide along on whatever pose was active (e.g. arms-crossed).
      // The per-frame sync would eventually do this on the next
      // snapshot tick, but visually it lags — the wrapper translates
      // for several frames before the motion changes.
      if (typeof handle.animator?.setMotion === 'function') {
        const walkId = animationLibrary.getRoleId('walk')
        const cached = walkId ? animationLibrary.peek(walkId) : null
        if (cached) {
          handle.animator.setMotion(cached, { loop: true, applyRootTranslation: false })
          handle.currentRole = 'walk'
        } else {
          animationLibrary.getRole('walk').then((m) => {
            if (m && handle.tutorialRole === 'walk' && typeof handle.animator?.setMotion === 'function') {
              handle.animator.setMotion(m, { loop: true, applyRootTranslation: false })
              handle.currentRole = 'walk'
            }
          }).catch(() => {})
        }
      }
      // Face the walk direction. Mirrors the existing walking-heading
      // formula at line ~1023: rotation.y = atan2(dx, dz). Pure-X
      // motion (dz=0): negative dx → -π/2 (face left), positive dx →
      // +π/2 (face right).
      if (dx < 0) handle.object3d.rotation.y = -Math.PI / 2
      else if (dx > 0) handle.object3d.rotation.y = Math.PI / 2
      const fromX = handle.object3d.position.x
      const fromY = handle.object3d.position.y
      const toX = fromX + dx
      const toY = fromY + dy
      handle.tutorialPosition = { x: fromX, y: fromY }
      const startedAt = performance.now()
      const dur = Math.max(1, ms)
      return new Promise((resolve) => {
        const step = () => {
          const t = Math.min(1, (performance.now() - startedAt) / dur)
          const x = fromX + (toX - fromX) * t
          const y = fromY + (toY - fromY) * t
          handle.object3d.position.x = x
          handle.object3d.position.y = y
          handle.tutorialPosition = { x, y }
          if (t >= 1) {
            // Hold the override position so subsequent snapshot ticks
            // don't snap the avatar back to its store position. Caller
            // can clear by setting opts.releasePosition.
            if (opts.releasePosition) handle.tutorialPosition = null
            handle.tutorialRole = null
            resolve()
            return
          }
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
    }

    // Resolve a named camera state to a (tx, ty, zoom) target. Keeps
    // the tutorial scripts free of magic numbers — they ask for
    // `room` or `home` and the math lives here.
    const computeCameraTarget = (state) => {
      if (state === CAMERA_STATE.HOME) {
        return homeFrame
          ? { x: homeFrame.centerX, y: homeFrame.centerY, zoom: homeFrame.zoom }
          : null
      }
      if (state === CAMERA_STATE.ROOM) {
        // Use the focused agent's room first (the tutorial usually
        // has Edi focused), then fall back to whichever room the
        // user last focused, then the first room in the layout.
        let roomMeta = null
        const focusId = focusedAgentIdRef.current
        if (focusId) {
          const ag = shelterStore.getSnapshot().agents?.[focusId]
          const rg = roomGroupForAgent(ag)
          if (rg) roomMeta = rg.userData.room
        }
        if (!roomMeta && focusedRoomMeta) roomMeta = focusedRoomMeta
        if (!roomMeta && roomGroups.length > 0) roomMeta = roomGroups[0].userData.room
        if (!roomMeta) return null
        const aspect = (renderer.domElement.clientWidth || 1) / (renderer.domElement.clientHeight || 1)
        const zoomByH = FRUSTUM_HEIGHT / roomMeta.h
        const zoomByW = (FRUSTUM_HEIGHT * aspect) / roomMeta.w
        const zoom = Math.min(Math.max(zoomByH, zoomByW), 8)
        return { x: roomMeta.cx, y: roomMeta.cy, zoom }
      }
      // Closeup not handled here — focusAgent({closeup:true}) is the
      // path that frames the bbox. Returning null leaves the caller
      // to no-op.
      return null
    }

    // Tween the camera to a named state WITHOUT clearing the current
    // focus state — focusRole / focusedAgentIdRef stay intact so the
    // sync loop keeps Edi in arms-crossed during the zoom out.
    const animateCameraTo = (state, ms) => {
      const target = computeCameraTarget(state)
      if (!target) return Promise.resolve()
      const dur = Math.max(1, ms ?? 1500)
      controls.setLock({})
      // Restore wide bounds so the camera can move freely; room-state
      // tweens don't need a tight clamp during the cinematic.
      if (homeBounds) controls.setBounds(homeBounds)
      tween.active = true
      tween.t0 = performance.now()
      tween.dur = dur
      tween.fx = camera.position.x
      tween.fy = camera.position.y
      tween.fz = camera.zoom
      tween.tx = target.x
      tween.ty = target.y
      tween.tz = target.zoom
      tween.onDone = null
      const startedAt = performance.now()
      return new Promise((resolve) => {
        const wait = () => {
          if (performance.now() - startedAt >= dur) resolve()
          else requestAnimationFrame(wait)
        }
        requestAnimationFrame(wait)
      })
    }

    // Drop any cinematic-only overrides on every live avatar AND
    // force-snap their wrapper position back to the snapshot's
    // projection so a tutorial restart puts Edi back in the middle
    // of the room without waiting for the next snapshot tick.
    const clearTutorialOverrides = () => {
      const projector = projectorRef.current
      const snapshot = shelterStore.getSnapshot()
      for (const [id, handle] of liveAvatarsRef.current.entries()) {
        if (!handle?.object3d) continue
        handle.tutorialPosition = null
        handle.tutorialRole = null
        handle.object3d.rotation.y = 0
        const ag = snapshot.agents?.[id]
        if (ag?.pos && projector) {
          const proj = projector.projectLocal(ag.pos.roomId, ag.pos.localU, ag.pos.localV)
          if (proj) {
            handle.object3d.position.set(proj.world.x, proj.world.y, proj.world.z)
          }
        }
      }
    }

    // Linear pan in lockstep with the parallel walk action — the
    // global tween system applies easeInOutCubic which gives a slow
    // start, so the camera lagged behind a linearly-walking Edi
    // during the parallel block. We bypass the tween here and write
    // camera.position directly each frame, matching animateAgentWalk.
    const animateCameraPan = (dx, dy, ms) => {
      const fromX = camera.position.x
      const fromY = camera.position.y
      const toX = fromX + dx
      const toY = fromY + dy
      controls.setLock({})
      tween.active = false   // cancel any prior eased tween
      const startedAt = performance.now()
      const dur = Math.max(1, ms)
      return new Promise((resolve) => {
        const step = () => {
          const t = Math.min(1, (performance.now() - startedAt) / dur)
          camera.position.x = fromX + (toX - fromX) * t
          camera.position.y = fromY + (toY - fromY) * t
          camera.updateProjectionMatrix()
          if (t >= 1) { resolve(); return }
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
    }

    const animateAgentWalkIn = async (pubkey, fromOffsetX, dx, ms) => {
      console.log('[tutorial-walkin] animateAgentWalkIn start', { pubkey, fromOffsetX, dx, ms })
      // The character may have just been added to the store and the
      // kimodo rig may still be loading; poll until the handle is
      // mounted and non-pending before parking them off-camera.
      // Bails after ~4s if nothing shows up so a missing avatar
      // doesn't deadlock the cinematic.
      let handle = null
      let agentId = null
      for (let i = 0; i < 40; i++) {
        const agents = Object.values(shelterStore.getSnapshot().agents ?? {})
        const agentRecord = agents.find((a) => a.pubkey === pubkey)
        if (i === 0) {
          console.log('[tutorial-walkin] initial poll — agent records:',
            agents.map((a) => ({ id: a.id, pubkey: a.pubkey?.slice(0, 12), pos: a.pos })))
        }
        if (agentRecord) {
          agentId = agentRecord.id
          const h = liveAvatarsRef.current.get(agentRecord.id)
          if (i % 5 === 0) {
            console.log('[tutorial-walkin] poll iter', i,
              'agent.id:', agentRecord.id,
              'agent.pos:', agentRecord.pos,
              'handle exists:', !!h,
              'pending:', h?.pending,
              'has object3d:', !!h?.object3d)
          }
          if (h && !h.pending && h.object3d) { handle = h; break }
        } else if (i % 5 === 0) {
          console.log('[tutorial-walkin] poll iter', i, 'no agent record yet for pubkey', pubkey?.slice(0, 12))
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      if (!handle) {
        console.warn('[tutorial-walkin] timed out waiting for handle. agentId:', agentId,
          'liveAvatars keys:', [...liveAvatarsRef.current.keys()])
        return
      }
      const wrapper = handle.object3d
      console.log('[tutorial-walkin] handle ready', {
        cameraX: camera.position.x, cameraY: camera.position.y, cameraZoom: camera.zoom,
        wrapperBefore: { x: wrapper.position.x, y: wrapper.position.y, z: wrapper.position.z },
        scale: { x: wrapper.scale.x, y: wrapper.scale.y, z: wrapper.scale.z },
        visible: wrapper.visible,
        parent: wrapper.parent?.name || wrapper.parent?.type || 'none',
        childCount: wrapper.children.length,
      })
      const startX = camera.position.x + fromOffsetX
      const startY = wrapper.position.y
      wrapper.position.x = startX
      handle.tutorialPosition = { x: startX, y: startY }
      wrapper.visible = true
      await animateAgentWalk(pubkey, dx, 0, ms)
      // World-space position so we know exactly where they ended up
      // relative to the camera (which is also in worldRoot's child
      // tree but with the pan applied to camera.position).
      const worldPos = new THREE.Vector3()
      wrapper.getWorldPosition(worldPos)
      console.log('[tutorial-walkin] walk-in animation complete', {
        wrapperLocal: { x: wrapper.position.x, y: wrapper.position.y, z: wrapper.position.z },
        wrapperWorld: { x: worldPos.x, y: worldPos.y, z: worldPos.z },
        cameraX: camera.position.x, cameraY: camera.position.y, cameraZoom: camera.zoom,
        visible: wrapper.visible,
        // Compute the visible world rectangle in worldRoot-local space
        // — anything outside this is off-screen.
        visibleHalfW: ((camera.right - camera.left) / 2) / camera.zoom,
        visibleHalfH: ((camera.top - camera.bottom) / 2) / camera.zoom,
      })
    }

    const unregisterStageHandler = registerStageHandler((cmd) => {
      if (cmd?.type === 'focusAgent' && cmd.agentId) focusAgent(cmd.agentId, cmd.opts)
      else if (cmd?.type === 'exitFocus') exitFocus()
      else if (cmd?.type === 'walkAgent') {
        animateAgentWalk(cmd.pubkey, cmd.dx, cmd.dy, cmd.ms).then(() => cmd.onComplete?.())
      } else if (cmd?.type === 'panCamera') {
        animateCameraPan(cmd.dx, cmd.dy, cmd.ms).then(() => cmd.onComplete?.())
      } else if (cmd?.type === 'walkInAgent') {
        animateAgentWalkIn(cmd.pubkey, cmd.fromOffsetX, cmd.dx, cmd.ms).then(() => cmd.onComplete?.())
      } else if (cmd?.type === 'cameraTo') {
        animateCameraTo(cmd.state, cmd.ms).then(() => cmd.onComplete?.())
      } else if (cmd?.type === 'clearTutorialOverrides') {
        clearTutorialOverrides()
        cmd.onComplete?.()
      }
    })

    // Debug rotation offsets (Ctrl+drag) — layered on top of the
    // auto-tilt that's driven by zoom, so the camera flatten-on-zoom
    // still works while the user is poking at the diorama.
    let debugRX = 0
    let debugRY = 0
    const controls = createPanZoomControls(camera, renderer.domElement, {
      minZoom: 0.4,
      maxZoom: 8,
      bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
      onUserInput: () => {
        tween.active = false
      },
      onModifierDrag: (dx, dy) => {
        debugRY += dx * 0.006
        debugRX += dy * 0.006
      },
    })

    const disposers = []
    const roomGroups = []  // for raycasting on tap
    let cancelled = false

    // ── Engine wiring (shelterWorld) ────────────────────────────────
    // characterRegistry polls the bridge + kimodo every 5s.
    // avatarFactory consumes it to spawn 3D avatars on demand.
    // presenceProjector lands once the layout JSON resolves.
    // Bootstrap the standard idle clip into animationLibrary so the
    // first kimodo spawn doesn't pay the fetch latency.
    animationLibrary.bootstrap()
    // When the user reassigns a role in the Animations tab, invalidate
    // every live avatar's currentRole so the next sync tick swaps in the
    // newly-assigned clip (or the idle fallback). Without this, agents
    // already in their target role keep playing the previous animation.
    const unsubRoles = animationLibrary.subscribe(() => {
      for (const handle of liveAvatarsRef.current.values()) {
        if (handle && !handle.pending) handle.currentRole = null
      }
    })
    const registry = createCharacterRegistry({ bridgeUrl: cfg.bridgeUrl })
    const factory = createAvatarFactory({ registry })
    factoryRef.current = factory
    worldRootRef.current = worldRoot
    // Registry change for a known pubkey → drop the cached avatar
    // so the sync effect respawns it with the new model.
    //
    // Match by handle.npub (set by avatarFactory.spawn to the lookup
    // key, i.e. the pubkey for bridge characters), not by live's
    // map key. live is keyed by agent.id, which can be a synthetic
    // dummy id and won't match the registry's pubkey-keyed events
    // — that mismatch is why fallback avatars stayed fallback after
    // the first registry poll completed (most visible after
    // navigating away from Shelter and back, where the factory
    // spawns *before* the registry's first poll resolves).
    const unsubRegistry = registry.subscribe(({ pubkey }) => {
      const live = liveAvatarsRef.current
      let foundId = null
      for (const [id, handle] of live.entries()) {
        if (handle?.pending) continue
        if (handle?.npub === pubkey) { foundId = id; break }
      }
      if (!foundId) return
      const handle = live.get(foundId)
      handle.dispose()
      live.delete(foundId)
      invalidationRef.current++
      setPresenceTick((n) => n + 1)
    })

    fetch('/shelter-layout.json')
      .then((r) => r.json())
      .then((layout) => {
        if (cancelled) return
        const cellW = layout.cellWidth ?? 2
        const cellH = layout.cellHeight ?? 1
        for (const room of layout.rooms ?? []) {
          const g = buildRoom(room, cellW, cellH)
          worldRoot.add(g)
          roomGroups.push(g)
          disposers.push(() => {
            g.traverse((o) => {
              if (o.geometry) o.geometry.dispose()
              if (o.material) {
                if (o.material.map) o.material.map.dispose()
                o.material.dispose()
              }
            })
          })
        }
        const b = computeBounds(layout.rooms ?? [], cellW, cellH)
        homeBounds = { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY }
        controls.setBounds(homeBounds)
        layoutBounds = b
        refit(true)
        projectorRef.current = createPresenceProjector({ layout })
        // Trigger the presence-sync effect once the projector exists
        // so any agents already in the room state get spawned.
        setPresenceTick((n) => n + 1)
      })
      .catch((e) => console.warn('[shelter] layout fetch failed', e))

    // ── Tap → focus ───────────────────────────────────────────────
    // Two single taps on the same room within DOUBLE_TAP_MS counts
    // as a double-tap. Double-tap a focused room to zoom back out.
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    let downX = 0, downY = 0
    let lastTapAt = 0
    let lastTapRoomId = null
    const onPointerDown = (e) => { downX = e.clientX; downY = e.clientY }
    const onClick = (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_PIXEL_TOLERANCE) return
      // Ctrl-click resets the debug rotation so the user can recover
      // from a confused angle. Single click is enough — no double-tap
      // needed since this only fires while a modifier is held.
      if (e.ctrlKey || e.metaKey) {
        debugRX = 0
        debugRY = 0
        return
      }
      const rect = renderer.domElement.getBoundingClientRect()
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(ndc, camera)

      // Prefer avatar hits — the user's intent when tapping a character
      // standing in a room is "select this character", not "double-tap
      // the room". A single tap is enough; double-tap-on-character
      // would be a separate gesture and we don't have a use for it.
      const avatarObjs = []
      for (const handle of liveAvatarsRef.current.values()) {
        if (handle && !handle.pending && handle.object3d) avatarObjs.push(handle.object3d)
      }
      const avatarHits = avatarObjs.length
        ? raycaster.intersectObjects(avatarObjs, true)
        : []
      if (avatarHits.length) {
        let node = avatarHits[0].object
        let agentId = null
        while (node) {
          if (node.userData?.agentId) { agentId = node.userData.agentId; break }
          node = node.parent
        }
        if (agentId) {
          if (focusedAgentIdRef.current === agentId) {
            // Tap-toggle off.
            exitFocus()
          } else {
            focusAgent(agentId)
          }
          return
        }
      }

      const hits = raycaster.intersectObjects(roomGroups, true)
      if (!hits.length) {
        // Tapped empty space — clear any active selection.
        if (focusedAgentIdRef.current) exitFocus()
        return
      }
      let node = hits[0].object
      let roomGroup = null
      while (node) {
        if (node.userData?.room) { roomGroup = node; break }
        node = node.parent
      }
      if (!roomGroup) return
      const roomId = roomGroup.userData.room.id
      const now = performance.now()
      const isDouble = roomId === lastTapRoomId && (now - lastTapAt) < DOUBLE_TAP_MS
      lastTapAt = now
      lastTapRoomId = roomId
      if (!isDouble) return

      // Double tap — toggle focus on/off.
      if (focusedRoomId === roomId) {
        exitFocus()
        return
      }
      const aspect = (renderer.domElement.clientWidth || 1) / (renderer.domElement.clientHeight || 1)
      const meta = roomGroup.userData.room
      // "Cover" framing — fill the screen with the room. The larger
      // of the two zoom factors makes the room cover the viewport on
      // its tightest axis, cropping the other. The user can drag
      // horizontally to pan across the cropped axis once locked.
      const zoomByH = FRUSTUM_HEIGHT / meta.h
      const zoomByW = (FRUSTUM_HEIGHT * aspect) / meta.w
      const toZoom = Math.min(Math.max(zoomByH, zoomByW), 8)
      // Drop any previous lock so the tween can drive freely.
      controls.setLock({})
      tween.active = true
      tween.t0 = now
      tween.dur = FOCUS_TWEEN_MS
      tween.fx = camera.position.x
      tween.fy = camera.position.y
      tween.fz = camera.zoom
      tween.tx = meta.cx
      tween.ty = meta.cy
      tween.tz = toZoom
      tween.onDone = () => applyFocus(roomGroup)
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('click', onClick)

    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)

      if (tween.active) {
        const t = Math.min(1, (performance.now() - tween.t0) / tween.dur)
        const k = easeInOutCubic(t)
        camera.position.x = tween.fx + (tween.tx - tween.fx) * k
        camera.position.y = tween.fy + (tween.ty - tween.fy) * k
        camera.zoom = tween.fz + (tween.tz - tween.fz) * k
        camera.updateProjectionMatrix()
        if (t >= 1) {
          tween.active = false
          const done = tween.onDone
          tween.onDone = null
          done?.()
        }
      }

      // Tick walkers + pacers — smooth per-frame lerp of
      // wrapper.position for any agent currently moving. The store
      // advances sim minutes at 4 Hz; we interpolate sub-second using
      // the wall-clock delta since the last clock tick so the visible
      // motion looks 60 fps even though the sim itself doesn't.
      //
      // Two cases share the same shape:
      //   - state === 'walking' → walkFrom → walkTo over WALK_DURATION_MIN
      //   - steady state w/ paceTo → paceFrom → paceTo over PACE_DURATION_MIN
      const projector = projectorRef.current
      if (projector) {
        const snapshot = shelterStore.getSnapshot()
        const fractionalSimMin = snapshot.simMinutes
          + Math.max(0, (Date.now() - snapshot.lastTickWallClock) / 1000)
        const live = liveAvatarsRef.current
        for (const a of Object.values(snapshot.agents ?? {})) {
          const handle = live.get(a.id)
          if (!handle || handle.pending) continue
          // Focused agents freeze — face-camera below still rotates
          // them, but no position writes here.
          if (focusedAgentIdRef.current === a.id) continue
          // Cinematic-controlled agents own their position + heading
          // for the duration. Skip the walker/pacer lerp so the 4Hz
          // resolver tick (which sets paceFrom/paceTo on idle
          // employees) doesn't yank the recruit back to the resolver's
          // path while the tutorial is animating them in.
          if (handle.tutorialPosition || handle.tutorialRole) continue

          let from, to, started, duration
          if (a.state === 'walking' && a.walkFrom && a.walkTo) {
            from = a.walkFrom; to = a.walkTo
            started = a.stateSince
            duration = WALK_DURATION_MIN
          } else if (a.paceFrom && a.paceTo && a.paceStartedAt != null) {
            from = a.paceFrom; to = a.paceTo
            started = a.paceStartedAt
            duration = PACE_DURATION_MIN
          } else {
            continue
          }

          const start = projector.projectLocal(from.roomId, from.localU, from.localV)
          const end = projector.projectLocal(to.roomId, to.localU, to.localV)
          if (!start || !end) continue
          const elapsed = fractionalSimMin - (started ?? fractionalSimMin)
          const t = Math.max(0, Math.min(1, elapsed / duration))
          const px = start.world.x + (end.world.x - start.world.x) * t
          const py = start.world.y + (end.world.y - start.world.y) * t
          const pz = start.world.z + (end.world.z - start.world.z) * t
          handle.object3d.position.set(px, py, pz)
          // Face direction-of-travel. Avatars' natural forward in
          // wrapper-local space is +Z (glTF convention), so rotating
          // by atan2(dx, dz) aligns +Z with the heading vector.
          // When stationary (no lerp), we leave rotation alone so
          // they keep facing wherever they last walked toward.
          // Focused agents skip this — face-camera below wins.
          if (focusedAgentIdRef.current !== a.id) {
            const dx = end.world.x - start.world.x
            const dz = end.world.z - start.world.z
            if (dx * dx + dz * dz > 1e-6) {
              handle.object3d.rotation.y = Math.atan2(dx, dz)
            }
          }
        }

        // Focused-agent face-camera. Compute the camera position in
        // worldRoot-local space (worldRoot has tilt + debug-Y) so that
        // setting wrapper.rotation.y around its own local axis lands
        // the wrapper-local +Z (avatar forward) toward the camera.
        const focusId = focusedAgentIdRef.current
        if (focusId) {
          const handle = live.get(focusId)
          // Skip the face-camera override while a cinematic walk is
          // animating — it would fight the walk's atan2-heading and
          // snap the avatar to face the camera (looks like they're
          // staring at the player while walking sideways).
          if (handle && !handle.pending && handle.object3d && !handle.tutorialRole) {
            worldRoot.updateMatrixWorld(true)
            const inv = _faceCamMat.copy(worldRoot.matrixWorld).invert()
            const camLocal = _faceCamVec.copy(camera.position).applyMatrix4(inv)
            const wrapper = handle.object3d
            const dx = camLocal.x - wrapper.position.x
            const dz = camLocal.z - wrapper.position.z
            if (dx * dx + dz * dz > 1e-6) {
              const target = Math.atan2(dx, dz)
              const cur = wrapper.rotation.y
              // Wrap delta to shortest signed angle so a snap from
              // +π/2 (walk-right) to 0 (face-camera) lerps the short
              // way around instead of looping through ±π. Without
              // this, the wrapper briefly rotates through angles
              // where parts of the rig overlap weirdly and the
              // avatar reads as "disappearing" for a few frames.
              let delta = target - cur
              while (delta > Math.PI) delta -= Math.PI * 2
              while (delta < -Math.PI) delta += Math.PI * 2
              if (Math.abs(delta) < 0.005) {
                wrapper.rotation.y = target
              } else {
                wrapper.rotation.y = cur + delta * 0.18
              }
            }
          }
          // Pulse the outline every frame: smooth sine wave drives both
          // colour (HIGHLIGHT_BASE → HIGHLIGHT_PEAK) and shader-uniform
          // thickness (OUTLINE_THICKNESS_MIN → MAX), so the highlight
          // breathes rather than just sitting there.
          if (pulseTargets.length) {
            const t = (performance.now() / 1000) * (Math.PI * 2 / PULSE_PERIOD_SEC)
            const k = (Math.sin(t) + 1) / 2
            _pulseColor.copy(HIGHLIGHT_BASE).lerp(HIGHLIGHT_PEAK, k)
            const thickness = OUTLINE_THICKNESS_MIN
              + (OUTLINE_THICKNESS_MAX - OUTLINE_THICKNESS_MIN) * k
            for (const mat of pulseTargets) {
              mat.color.copy(_pulseColor)
              if (mat.userData.uThickness) mat.userData.uThickness.value = thickness
            }
          }
        }
      }

      // Tick avatar animators (kimodo) before rendering.
      factory.tick()

      // Tilt-on-zoom — flatten the world toward TILT_MIN as zoom rises.
      // Map zoom 1.0 → TILT_MAX, zoom 3.0+ → TILT_MIN. Debug offsets
      // from Ctrl+drag stack on top so the live tilt isn't lost.
      const z = camera.zoom
      const k = Math.max(0, Math.min(1, (z - 1) / 2))
      worldRoot.rotation.x = TILT_MAX + (TILT_MIN - TILT_MAX) * k + debugRX
      worldRoot.rotation.y = debugRY

      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('click', onClick)
      try { unregisterStageHandler() } catch {}
      try { unsubRegistry() } catch {}
      try { unsubRoles() } catch {}
      try { registry.dispose() } catch {}
      try { factory.dispose() } catch {}
      factoryRef.current = null
      projectorRef.current = null
      worldRootRef.current = null
      liveAvatarsRef.current.clear()
      for (const d of disposers) d()
      try { pmrem.dispose() } catch {}
      try { scene.environment?.dispose() } catch {}
      renderer.dispose()
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement)
      }
    }
  }, [])

  // ── Store sync ────────────────────────────────────────────────────
  // Spawn / despawn / reposition avatars to match the local
  // ShelterStore. Each agent in the store has a `pos` produced by
  // the schedule resolver; we project it into world coords and place
  // the avatar there. Walking agents are hidden — Phase 4+ will
  // animate them through corridors.
  //
  // Avatar spawn keys on `agent.id`. If the agent has a bridge
  // pubkey it's used to look up the model; otherwise the factory
  // falls through to /avatar.glb.
  useEffect(() => {
    const factory = factoryRef.current
    const projector = projectorRef.current
    const worldRoot = worldRootRef.current
    if (!factory || !projector || !worldRoot) return
    let cancelled = false
    const live = liveAvatarsRef.current
    const agents = Object.values(shelterSnapshot?.agents ?? {})
    const desired = new Set()

    for (const a of agents) {
      if (!a.id || !a.pos) continue
      const projection = projector.projectLocal(a.pos.roomId, a.pos.localU, a.pos.localV)
      if (!projection) continue
      desired.add(a.id)
      const existing = live.get(a.id)
      // Walking AND pacing agents are positioned per-frame by the
      // walker/pacer tick (smooth lerp). Skip the discrete set here
      // so the sync effect doesn't pop the avatar back to its stale
      // anchor pos between resolver ticks.
      const isWalking = a.state === 'walking' && a.walkFrom && a.walkTo
      const isPacing = a.paceMode === 'moving'
        && !!(a.paceFrom && a.paceTo && a.paceStartedAt != null)
      const isLerping = isWalking || isPacing
      const isResting = a.paceMode === 'resting'
      if (existing && !existing.pending) {
        // Focused agents are frozen in place — skip both the lerp
        // (handled in the per-frame loop) and the snapshot-driven
        // position write here. Without this, a resolver tick that
        // shifts agent.pos (e.g. move→rest sets pos=paceTo) would
        // teleport the focused character mid-wave.
        const isFocused = focusedAgentIdRef.current === a.id
        // Cinematic position lock — when the tutorial is animating
        // the wrapper itself (e.g. Edi walking off-frame), keep it
        // at the override and skip both the snapshot write and the
        // lerp that would fight us.
        const tutorialPinned = !!existing.tutorialPosition
        if (!isLerping && !isFocused && !tutorialPinned) {
          existing.object3d.position.set(
            projection.world.x,
            projection.world.y,
            projection.world.z,
          )
        }
        existing.object3d.visible = true
        // Per-state motion swap. Walking AND pacing agents get the
        // user-assigned 'walk' clip (or fall back to idle when none
        // is assigned — animationLibrary.getRole resolves the
        // fallback). Idle / event / asleep agents get the assigned
        // idle. Each handle remembers its current role so we don't
        // churn setMotion() every frame.
        if (existing.animator) {
          const isFocused = focusedAgentIdRef.current === a.id
          // tutorialRole wins over everything — the cinematic owns
          // motion while it's animating. Otherwise, focused agents
          // use focusRole, then fall through to lerp/rest/idle.
          const wantedRole = existing.tutorialRole
            ? existing.tutorialRole
            : isFocused
              ? (existing.focusRole ?? 'wave')
              : isLerping
                ? 'walk'
                : isResting
                  ? (a.paceRestRole ?? 'idle')
                  : 'idle'
          // Only the kimodo-rigged avatar tier exposes setMotion — the
          // static + fallback tiers use a THREE.AnimationMixer-shaped
          // animator that has no role concept. Skip role-swap for
          // those (e.g. Edi, currently rendered via the fallback
          // avatar.glb until she gets a kimodo rig).
          const canSwapRole =
            typeof existing.animator?.setMotion === 'function'
          if (canSwapRole && existing.currentRole !== wantedRole) {
            const wantedId = animationLibrary.getRoleId(wantedRole)
            const motion = animationLibrary.peek(wantedId)
            if (motion) {
              existing.animator.setMotion(motion, { loop: true, applyRootTranslation: false })
              existing.currentRole = wantedRole
            } else {
              // Not in cache yet — fetch and apply once it resolves. Mark the
              // role optimistically so we don't spam fetches each frame.
              existing.currentRole = wantedRole
              animationLibrary.getRole(wantedRole).then((m) => {
                if (m && existing.animator && typeof existing.animator.setMotion === 'function'
                    && existing.currentRole === wantedRole) {
                  existing.animator.setMotion(m, { loop: true, applyRootTranslation: false })
                }
              })
            }
          }
        }
        continue
      }
      if (existing?.pending) continue
      live.set(a.id, { pending: true })
      const lookupKey = a.pubkey ?? a.id
      factory.spawn(lookupKey).then((handle) => {
        if (cancelled) { handle.dispose(); return }
        // Tag the wrapper with the agent id so the click raycast can
        // walk parents from a mesh hit back to the owning agent.
        handle.object3d.userData.agentId = a.id
        worldRoot.add(handle.object3d)
        // For lerping agents (walking or pacing), place at the
        // current source so they don't pop to the destination before
        // the per-frame tick takes over.
        const sourceFrom = isWalking ? a.walkFrom : isPacing ? a.paceFrom : null
        const initial = sourceFrom
          ? projector.projectLocal(sourceFrom.roomId, sourceFrom.localU, sourceFrom.localV)
          : projection
        const placeAt = initial ?? projection
        handle.object3d.position.set(
          placeAt.world.x,
          placeAt.world.y,
          placeAt.world.z,
        )
        handle.object3d.visible = true
        live.set(a.id, handle)
      }).catch((err) => {
        live.delete(a.id)
        console.warn('[shelter] avatar spawn failed for', a.id, err?.message || err)
      })
    }
    for (const [id, handle] of [...live.entries()]) {
      if (desired.has(id)) continue
      // If the focused agent is being despawned, clear focus before
      // their wrapper goes away — otherwise the next per-frame tick
      // dereferences a disposed handle.
      if (focusedAgentIdRef.current === id) {
        try { focusedAgentRestoreRef.current?.() } catch {}
        focusedAgentRestoreRef.current = null
        focusedAgentIdRef.current = null
        onAgentFocusChangeRef.current?.(null)
      }
      if (handle.dispose) handle.dispose()
      live.delete(id)
    }
    return () => { cancelled = true }
  }, [shelterSnapshot, presenceTick])

  return <div ref={hostRef} className="shelter-stage3d" />
}

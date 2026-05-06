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

export default function ShelterStage3D({ onFocusChange = null } = {}) {
  const hostRef = useRef(null)
  const onFocusChangeRef = useRef(onFocusChange)
  useEffect(() => { onFocusChangeRef.current = onFocusChange }, [onFocusChange])

  // Engine handles to live longer than the main effect's closure so a
  // sibling presence-sync effect can spawn / despawn / reposition
  // avatars without re-running scene setup.
  const factoryRef = useRef(null)
  const projectorRef = useRef(null)
  const worldRootRef = useRef(null)
  const liveAvatarsRef = useRef(new Map())  // npub → spawn handle
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
      const hits = raycaster.intersectObjects(roomGroups, true)
      if (!hits.length) return
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
          const dx = end.world.x - start.world.x
          const dz = end.world.z - start.world.z
          if (dx * dx + dz * dz > 1e-6) {
            handle.object3d.rotation.y = Math.atan2(dx, dz)
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
      try { unsubRegistry() } catch {}
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
      const isPacing = !!(a.paceFrom && a.paceTo && a.paceStartedAt != null)
      const isLerping = isWalking || isPacing
      if (existing && !existing.pending) {
        if (!isLerping) {
          existing.object3d.position.set(
            projection.world.x,
            projection.world.y,
            projection.world.z,
          )
        }
        existing.object3d.visible = true
        continue
      }
      if (existing?.pending) continue
      live.set(a.id, { pending: true })
      const lookupKey = a.pubkey ?? a.id
      factory.spawn(lookupKey).then((handle) => {
        if (cancelled) { handle.dispose(); return }
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
      if (handle.dispose) handle.dispose()
      live.delete(id)
    }
    return () => { cancelled = true }
  }, [shelterSnapshot, presenceTick])

  return <div ref={hostRef} className="shelter-stage3d" />
}

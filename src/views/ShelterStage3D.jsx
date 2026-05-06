import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { createPanZoomControls } from '../lib/panZoomControls.js'
import { buildDressing, ROOM_DEPTH } from '../lib/shelterDressing.js'

const CHARACTER_HEIGHT = 0.5  // world units — see shelterDressing.js

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
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c })

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
  group.add(buildDressing(room.category, w, h))

  // Pendant light fixture — a real visible object the lamp glow
  // emits from. Cord drops from ceiling, housing hangs at the front,
  // bulb pad on the underside reads as the light source.
  const lampColor = LAMP_COLORS[room.category] ?? 0xffd9a8
  const cordY = h / 2 - 0.13
  const housingY = h / 2 - 0.27
  const fixtureZ = 0.12
  const cord = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.18, 0.02),
    new THREE.MeshLambertMaterial({ color: 0x101418 }),
  )
  cord.position.set(0, cordY, fixtureZ)
  group.add(cord)
  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.06, 0.2),
    new THREE.MeshLambertMaterial({ color: 0x202830 }),
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
  const lamp = new THREE.PointLight(lampColor, 1.1, ROOM_DEPTH * 1.3, 1.6)
  lamp.position.set(0, housingY - 0.05, fixtureZ)
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

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.touchAction = 'none'

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x14171b)

    // Dim ambient — per-room point lights do the heavy lifting.
    const hemi = new THREE.HemisphereLight(0xb8c8d8, 0x2a2530, 0.25)
    scene.add(hemi)
    const dir = new THREE.DirectionalLight(0xffffff, 0.35)
    dir.position.set(1.5, 2.0, 1.2)
    scene.add(dir)

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

    // ── Avatar template + character swap ───────────────────────────
    // Load avatar.glb once. When ready (and after rooms exist), walk
    // the world and replace each character placeholder's primitive
    // children with a cloned scaled avatar. Idempotent via
    // userData.charSpawned so the layout-load and avatar-load can
    // resolve in either order.
    let avatarTemplate = null
    let avatarScale = 1
    let avatarFeetY = 0
    const swapCharacters = () => {
      if (!avatarTemplate) return
      worldRoot.traverse((obj) => {
        if (!obj.userData?.charSpec || obj.userData.charSpawned) return
        // Drop the placeholder primitives.
        for (let i = obj.children.length - 1; i >= 0; i--) {
          const c = obj.children[i]
          obj.remove(c)
          c.traverse?.((n) => {
            if (n.geometry) n.geometry.dispose()
            if (n.material) {
              const mats = Array.isArray(n.material) ? n.material : [n.material]
              for (const m of mats) m.dispose()
            }
          })
        }
        const clone = avatarTemplate.clone(true)
        clone.scale.setScalar(avatarScale)
        clone.position.y = -avatarFeetY * avatarScale
        clone.rotation.y = Math.PI
        obj.add(clone)
        obj.userData.charSpawned = true
      })
    }
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://unpkg.com/three@0.184.0/examples/jsm/libs/draco/gltf/')
    const loader = new GLTFLoader().setDRACOLoader(draco)
    loader.load(
      '/avatar.glb',
      (gltf) => {
        if (cancelled) return
        const root = gltf.scene
        const bbox = new THREE.Box3().setFromObject(root)
        const size = bbox.getSize(new THREE.Vector3())
        avatarScale = size.y > 0 ? CHARACTER_HEIGHT / size.y : 1
        avatarFeetY = bbox.min.y
        avatarTemplate = root
        swapCharacters()
      },
      undefined,
      (err) => console.warn('[shelter] avatar.glb load failed', err?.message || err),
    )

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
        swapCharacters()
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
      for (const d of disposers) d()
      try { draco.dispose() } catch {}
      renderer.dispose()
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement)
      }
    }
  }, [])

  return <div ref={hostRef} className="shelter-stage3d" />
}

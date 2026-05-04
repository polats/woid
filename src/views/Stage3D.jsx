import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'

/**
 * Replace a live agent group's template avatar with a clone of a
 * loaded custom GLB (e.g. a Trellis-generated character model).
 * Stops the placeholder's animation mixer, removes the template,
 * adds a centered + scaled clone of the custom model, then
 * repositions the profile-pic sprite to the new height.
 *
 * Trellis GLBs have no skeleton, so plain Object3D.clone() is fine —
 * SkeletonUtils.clone is only required for rigged meshes.
 */
function applyCustomModel(group, entry) {
  if (!group || !entry || entry.status !== 'ready') return
  if (group.userData.customApplied) return

  // Tear down placeholder + its mixer.
  if (group.userData.mixer) {
    group.userData.mixer.stopAllAction()
    group.userData.mixer = null
  }
  const placeholder = group.userData.placeholder
  if (placeholder) {
    group.remove(placeholder)
    placeholder.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.()
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) {
          if (m.map?.dispose) m.map.dispose()
          m.dispose?.()
        }
      }
    })
    group.userData.placeholder = null
  }

  // Add a centered, ground-aligned clone of the custom model.
  // Object3D.clone() shares geometry/material with the source — when
  // an agent later leaves the room and the live group is disposed,
  // those shared resources would be freed under the cached source's
  // feet. Deep-clone meshes so per-agent disposal is local.
  const inst = entry.root.clone(true)
  inst.traverse((o) => {
    if (o.isMesh) {
      if (o.geometry) o.geometry = o.geometry.clone()
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => m.clone())
        : o.material.clone()
    }
  })
  const localBox = new THREE.Box3().setFromObject(inst)
  const ctr = localBox.getCenter(new THREE.Vector3())
  // Three.js composes the local matrix as T·R·S, so position is
  // applied in inst's *parent* space — the translation has to use the
  // scaled bbox bounds, not the raw ones, or the mesh sinks below
  // y=0 by `min.y * (scale - 1)`. Set scale first, then translate by
  // the scaled offset.
  inst.scale.setScalar(entry.scale)
  inst.position.set(
    -ctr.x * entry.scale,
    -localBox.min.y * entry.scale,
    -ctr.z * entry.scale,
  )
  group.add(inst)
  group.userData.customApplied = true
  group.userData.customMesh = inst

  // Move the profile sprite to the top of the now-final figure.
  const finalHeight = entry.baseHeight * entry.scale
  if (group.userData.sprite) {
    group.userData.sprite.position.y = finalHeight + 0.25
  }
}

/**
 * Three.js scene viewer mirroring ../3d-stage/viewer/index.html. Loads
 * /scene.glb (copied from references/3d-stage), frames the model, and
 * lets the user orbit it. The container fills its parent so the same
 * component works inside the desktop phone-frame and on a fullscreen
 * mobile viewport — `ResizeObserver` keeps the renderer in sync.
 */
// Three.js GLTFLoader runs node names through PropertyBinding's
// sanitizer — spaces become underscores, dots are stripped — so
// `Table.001` in the GLB is exposed as `Table001` on the loaded
// node. Mirror that here so JSON / hardcoded lookups still match.
const sanitizeName = (n) => (n || '').replace(/\s/g, '_').replace(/\./g, '')

/**
 * Stable hue (0..360) derived from a string. Used to pick a tint
 * per agent so avatars are visually distinguishable on stage but
 * the same npub always gets the same color across reloads.
 */
function hueFromString(s) {
  let h = 0
  for (let i = 0; i < (s || '').length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h % 360
}

/**
 * Make a Sprite that displays a circular profile picture. The
 * texture is drawn into an offscreen canvas with a circular clip,
 * so it works for any image URL — no shader gymnastics. Falls back
 * to an initial-letter circle while the image loads (or fails).
 */
function makeProfileSprite(imageUrl, name) {
  const SIZE = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext('2d')

  const drawFallback = () => {
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.fillStyle = '#3d4a5c'
    ctx.beginPath()
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 64px system-ui'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText((name || '?').trim().charAt(0).toUpperCase(), SIZE / 2, SIZE / 2 + 4)
  }

  drawFallback()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace

  if (imageUrl) {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      ctx.clearRect(0, 0, SIZE, SIZE)
      ctx.save()
      ctx.beginPath()
      ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2)
      ctx.closePath()
      ctx.clip()
      ctx.drawImage(img, 0, 0, SIZE, SIZE)
      ctx.restore()
      // Thin white ring so the badge reads against any backdrop.
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2)
      ctx.stroke()
      texture.needsUpdate = true
    }
    img.onerror = () => { /* keep fallback */ }
    img.src = imageUrl
  }

  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  // Sprite sizing in world units — ~0.45m circle floats over a ~1.6m
  // tall avatar; tweak if avatars look unbalanced.
  sprite.scale.set(0.45, 0.45, 1)
  return sprite
}

const STRUCTURAL_NODES = new Set([
  'Floor', 'Wall1', 'Wall2', 'Window Board',
  'Beam2', 'Beam2.001', 'Beam3', 'Beam4', 'Beam5',
  'Cube', 'Cube.001', 'Cube.002', 'Cube.003', 'Cube.004',
  'Cube.005', 'Cube.006', 'Cube.007', 'Cube.008',
  'Ground Plate', 'IrradianceVolume',
  'Bounce Light', 'Spot_Outside', 'Fill Light', 'Fill Light.001',
  'Camera', 'Empty', 'Scene',
].map(sanitizeName))

export default function Stage3D({
  floorColor = null,
  visibleObjects = null,
  agents = [],   // [{ npub, name, avatarUrl }, ...] currently in the room
} = {}) {
  const hostRef = useRef(null)
  const [pct, setPct] = useState(0)
  const [error, setError] = useState(null)
  const [loaded, setLoaded] = useState(false)
  // Refs so the floorColor prop can drive an existing scene without
  // tearing down the WebGL context on every change. Walls are
  // recolored alongside the floor so the whole room reads as the
  // selected color.
  const floorMatRef = useRef(null)
  const floorOriginalColorRef = useRef(null)
  const wallMatsRef = useRef([])
  const wallOriginalColorsRef = useRef([])
  // All decorative top-level nodes by name — we toggle .visible on
  // these when `visibleObjects` changes.
  const decorativeNodesRef = useRef(new Map())
  // Avatar plumbing — sceneRef + floorRef so the agents-diff effect
  // can attach instances to the live scene. avatarTemplateRef holds
  // the parsed avatar.glb root (cloned per agent). avatarsRef maps
  // npub → instance group so we can diff add/remove.
  const sceneRef = useRef(null)
  const floorRef = useRef(null)
  const cameraRef = useRef(null)
  const avatarTemplateRef = useRef(null)
  const avatarClipsRef = useRef([])
  const avatarsRef = useRef(new Map())
  const clockRef = useRef(null)
  // Per-character Trellis GLBs, keyed by their bridge URL.
  // Value shape: { status: 'pending' | 'absent' | 'failed' | 'ready',
  //                root?: THREE.Group, baseHeight?: number, scale?: number }
  // Once 'ready', any agent group flagged with this modelUrl gets the
  // generic template swapped out for a clone of the custom model.
  const customModelCacheRef = useRef(new Map())

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

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x202327)
    sceneRef.current = scene

    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.6

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500)
    camera.position.set(6, 4, 8)
    cameraRef.current = camera

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    const resize = () => {
      const w = host.clientWidth || 1
      const h = host.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()

    const ro = new ResizeObserver(resize)
    ro.observe(host)

    let cancelled = false
    // scene.glb uses Draco mesh compression. Pull the decoder from
    // the same CDN as the standalone 3d-stage viewer so we don't
    // have to vendor binaries into public/.
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://unpkg.com/three@0.184.0/examples/jsm/libs/draco/gltf/')
    const loader = new GLTFLoader().setDRACOLoader(draco)
    loader.load(
      '/scene.glb',
      (gltf) => {
        if (cancelled) return
        scene.add(gltf.scene)
        // Disable any lights baked into the GLB — env lighting only.
        // Also stash the Floor's material so the parent can recolor
        // it via the `floorColor` prop without reloading the scene.
        gltf.scene.traverse((o) => {
          if (o.isLight) o.visible = false
          // Clone materials before stashing so recolors don't mutate
          // shared materials referenced by other meshes in the GLB.
          if (o.name === 'Floor' && o.material) {
            o.material = o.material.clone()
            floorMatRef.current = o.material
            floorOriginalColorRef.current = o.material.color.clone()
            floorRef.current = o
          }
          if (/^Wall\d*$/i.test(o.name) && o.material) {
            o.material = o.material.clone()
            wallMatsRef.current.push(o.material)
            wallOriginalColorsRef.current.push(o.material.color.clone())
          }
        })
        // Walk top-level wrappers (and any named children of an
        // `Empty` container) and register the decorative ones. We
        // skip generic "Mesh" names because three.js auto-assigns
        // those to interior primitives — those would otherwise get
        // hidden alongside their wrapper.
        const indexDecorative = (root) => {
          for (const child of root.children) {
            const name = child.name || ''
            if (name && STRUCTURAL_NODES.has(name)) continue
            // Recurse through unnamed containers and explicit
            // `Empty` groups; they're just glTF organization.
            if (!name || name === 'Empty' || name === 'Scene') {
              indexDecorative(child)
              continue
            }
            // Skip auto-generated mesh primitive names; the wrapper
            // node already represents the object.
            if (name === 'Mesh' || /^Mesh(\.\d+)?$/.test(name)) continue
            decorativeNodesRef.current.set(name, child)
          }
        }
        indexDecorative(gltf.scene)
        const box = new THREE.Box3().setFromObject(gltf.scene)
        const size = box.getSize(new THREE.Vector3()).length()
        const center = box.getCenter(new THREE.Vector3())
        controls.target.copy(center)
        camera.near = size / 1000
        camera.far = size * 10
        camera.position.copy(center).add(new THREE.Vector3(size / 2, size / 3, size / 2))
        camera.updateProjectionMatrix()
        controls.update()
        // Load the animated avatar template after the scene. The
        // GLB ships with HappyIdle / SadIdle / TPose clips. We
        // SkeletonUtils.clone() the rig per agent so each instance
        // can run its own AnimationMixer.
        loader.load('/avatar_animated.glb', (avatarGltf) => {
          if (cancelled) return
          const root = avatarGltf.scene
          root.scale.setScalar(0.7)
          // Estimate rig height up-front using a TPose pass — used to
          // place the profile-pic sprite above the head. We can't
          // measure the running animation reliably (limbs swing).
          root.updateMatrixWorld(true)
          const aBox = new THREE.Box3().setFromObject(root)
          root.userData.avatarHeight = aBox.getSize(new THREE.Vector3()).y
          avatarTemplateRef.current = root
          avatarClipsRef.current = avatarGltf.animations || []
          setLoaded(true)
        }, undefined, () => {
          // Avatar load failure shouldn't block the rest of the
          // scene — just no agent rendering.
          setLoaded(true)
        })
      },
      (e) => {
        if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100))
      },
      (err) => setError(err?.message || 'Failed to load scene'),
    )

    const clock = new THREE.Clock()
    clockRef.current = clock
    renderer.setAnimationLoop(() => {
      controls.update()
      const delta = clock.getDelta()
      // Advance every avatar's mixer so the HappyIdle (or other) clip
      // plays smoothly. Each instance owns its own mixer.
      for (const group of avatarsRef.current.values()) {
        group.userData.mixer?.update(delta)
      }
      renderer.render(scene, camera)
    })

    return () => {
      // An exception during cleanup propagates out of the effect and
      // crashes the React tree on unmount — on mobile that means a
      // white-screen. Wrap each step so a failure in one disposal
      // can't take down the rest.
      const safe = (label, fn) => {
        try { fn() } catch (err) {
          console.warn(`[Stage3D] cleanup ${label} failed:`, err?.message || err)
        }
      }
      cancelled = true
      safe('ro', () => ro.disconnect())
      safe('animLoop', () => renderer.setAnimationLoop(null))
      safe('controls', () => controls.dispose())
      safe('draco', () => draco.dispose())
      safe('pmrem', () => pmrem.dispose())
      safe('scene-traverse', () => {
        scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose()
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            for (const m of mats) {
              for (const k in m) {
                const v = m[k]
                if (v && v.isTexture) v.dispose()
              }
              m.dispose()
            }
          }
        })
      })
      safe('env', () => { if (scene.environment) scene.environment.dispose() })
      // forceContextLoss can throw on browsers without the
      // WEBGL_lose_context extension. Defer renderer.dispose() to a
      // microtask so any in-flight loader callbacks resolve against
      // a still-valid renderer first.
      safe('contextLoss', () => renderer.forceContextLoss())
      safe('renderer-dispose', () => renderer.dispose())
      safe('detach', () => {
        if (renderer.domElement.parentNode === host) {
          host.removeChild(renderer.domElement)
        }
      })
    }
  }, [])

  // Drive the Floor color from the prop. Runs whenever the prop or
  // the load-state changes (since the Floor material isn't stashed
  // until the GLB finishes loading).
  useEffect(() => {
    const floor = floorMatRef.current
    if (floor) {
      if (floorColor) floor.color.set(floorColor)
      else if (floorOriginalColorRef.current) floor.color.copy(floorOriginalColorRef.current)
    }
    const walls = wallMatsRef.current
    walls.forEach((mat, i) => {
      if (floorColor) mat.color.set(floorColor)
      else if (wallOriginalColorsRef.current[i]) mat.color.copy(wallOriginalColorsRef.current[i])
    })
  }, [floorColor, loaded])

  // ── Agent avatars in the room ─────────────────────────────────
  // Diff the `agents` prop against the live scene. Each agent gets
  // a cloned avatar.glb plus a circular profile-pic sprite anchored
  // above the head. Multiple agents are spread in a small ring on
  // the floor so they don't overlap.
  useEffect(() => {
    const scene = sceneRef.current
    const tmpl = avatarTemplateRef.current
    const floor = floorRef.current
    const camera = cameraRef.current
    if (!scene || !tmpl || !floor || !camera) return

    // Floor surface — top of its bbox is where avatar feet rest.
    const fBox = new THREE.Box3().setFromObject(floor)
    const floorTopY = fBox.max.y
    const floorCenter = fBox.getCenter(new THREE.Vector3())
    const wanted = new Map((agents ?? []).map((a) => [a.npub, a]))
    const live = avatarsRef.current

    // Remove avatars whose agent is no longer in the room.
    for (const [npub, group] of [...live.entries()]) {
      if (wanted.has(npub)) continue
      group.userData.mixer?.stopAllAction()
      group.userData.mixer = null
      scene.remove(group)
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.()
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) { if (m.map?.dispose) m.map.dispose(); m.dispose?.() }
        }
      })
      live.delete(npub)
    }

    // Place agents around the floor center in a small ring so they
    // don't pile on top of each other.
    const total = wanted.size
    let idx = 0
    for (const [npub, agent] of wanted) {
      let group = live.get(npub)
      if (!group) {
        group = new THREE.Group()
        // SkeletonUtils.clone is required for rigged meshes — plain
        // Object3D.clone re-uses the bone graph and breaks animation
        // when multiple instances share a Skeleton.
        const inst = SkeletonUtils.clone(tmpl)
        // Per-agent muted tint — derived from the npub so it's
        // stable across reloads. Mid-saturation/mid-lightness reads
        // distinct without going cartoonish or washing out against
        // the pastel rooms.
        const hue = hueFromString(agent.npub) / 360
        const tintColor = new THREE.Color().setHSL(hue, 0.35, 0.55)
        const tintMat = (m) => {
          const cloned = m.clone()
          if (cloned.color) cloned.color.copy(tintColor)
          return cloned
        }
        inst.traverse((o) => {
          if (o.isMesh && o.material) {
            o.material = Array.isArray(o.material)
              ? o.material.map(tintMat)
              : tintMat(o.material)
          }
        })
        group.add(inst)
        // Profile-pic sprite — circular crop drawn into a canvas
        // texture. Positioned above the avatar's head; faces camera
        // automatically because Sprites always do.
        const sprite = makeProfileSprite(agent.avatarUrl, agent.name)
        sprite.position.y = (tmpl.userData.avatarHeight ?? 1.6) + 0.25
        group.add(sprite)
        // Mixer + HappyIdle. Pick the first clip whose name matches
        // (case-insensitive) and fall back to "anything not TPose"
        // so future clip lists don't break the loop.
        const clips = avatarClipsRef.current
        if (clips.length) {
          const mixer = new THREE.AnimationMixer(inst)
          const happy = clips.find((c) => /happy.?idle/i.test(c.name))
            ?? clips.find((c) => !/tpose|t.pose|rest/i.test(c.name))
            ?? clips[0]
          mixer.clipAction(happy).reset().play()
          group.userData.mixer = mixer
        }
        // Track refs so we can swap in a custom Trellis model later.
        group.userData.placeholder = inst
        group.userData.sprite = sprite
        group.userData.modelUrl = agent.modelUrl ?? null
        scene.add(group)
        live.set(npub, group)

        // If this character has a custom GLB, kick off the load (or
        // pull from cache). When ready, swap the template out.
        if (agent.modelUrl) {
          const cache = customModelCacheRef.current
          const cached = cache.get(agent.modelUrl)
          if (cached?.status === 'ready') {
            applyCustomModel(group, cached)
          } else if (!cached) {
            cache.set(agent.modelUrl, { status: 'pending' })
            // HEAD-probe first so 404s don't trip the loader's
            // console.error path. Only kick the loader on 200.
            fetch(agent.modelUrl, { method: 'HEAD' })
              .then((r) => {
                if (!r.ok) {
                  cache.set(agent.modelUrl, { status: 'absent' })
                  return
                }
                // Trellis output isn't Draco-compressed, so a plain
                // GLTFLoader is enough; we don't need access to the
                // mount effect's draco instance from here.
                const customLoader = new GLTFLoader()
                customLoader.load(
                  agent.modelUrl,
                  (gltf) => {
                    const root = gltf.scene
                    root.updateMatrixWorld(true)
                    const box = new THREE.Box3().setFromObject(root)
                    const size = box.getSize(new THREE.Vector3())
                    const baseHeight = size.y || 1
                    const targetHeight = avatarTemplateRef.current?.userData?.avatarHeight ?? 1.6
                    // Match the template's apparent on-stage height. The
                    // template gets root.scale.setScalar(0.7) at load
                    // time, and avatarHeight is measured *after* that —
                    // so just match it directly here.
                    const scale = targetHeight / baseHeight
                    const entry = { status: 'ready', root, baseHeight, scale }
                    cache.set(agent.modelUrl, entry)
                    // Swap into any live agent group that's still
                    // showing the placeholder for this URL.
                    for (const [, g] of avatarsRef.current) {
                      if (g.userData.modelUrl === agent.modelUrl && !g.userData.customApplied) {
                        applyCustomModel(g, entry)
                      }
                    }
                  },
                  undefined,
                  () => cache.set(agent.modelUrl, { status: 'failed' }),
                )
              })
              .catch(() => cache.set(agent.modelUrl, { status: 'failed' }))
          }
        }
      }
      // Ring placement (radius scales with agent count).
      const radius = total > 1 ? Math.min(0.6, 0.25 * total) : 0
      const angle = total > 1 ? (idx / total) * Math.PI * 2 : 0
      group.position.set(
        floorCenter.x + Math.cos(angle) * radius,
        floorTopY,
        floorCenter.z + Math.sin(angle) * radius,
      )
      // Yaw-only face the camera.
      const dx = camera.position.x - group.position.x
      const dz = camera.position.z - group.position.z
      group.rotation.y = Math.atan2(dx, dz)
      idx++
    }
  }, [agents, loaded])

  // Drive decorative-node visibility from the `visibleObjects` prop.
  // null = show all (default scene). Array = show only those names.
  useEffect(() => {
    const nodes = decorativeNodesRef.current
    if (nodes.size === 0) return
    if (visibleObjects == null) {
      for (const node of nodes.values()) node.visible = true
      return
    }
    const allow = new Set(visibleObjects.map(sanitizeName))
    for (const [name, node] of nodes) {
      node.visible = allow.has(name)
    }
  }, [visibleObjects, loaded])

  return (
    <div className="game-stage3d" ref={hostRef}>
      {!loaded && !error && (
        <div className="game-stage3d-hud">Loading scene… {pct}%</div>
      )}
      {error && <div className="game-stage3d-hud game-stage3d-hud-err">{error}</div>}
    </div>
  )
}

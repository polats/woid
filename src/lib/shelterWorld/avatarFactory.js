import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { Animator as KimodoAnimator } from '../kimodo/animator.js'
import { animationLibrary } from './animationLibrary.js'

/**
 * avatarFactory — given an npub, hand back a ready-to-render Three.js
 * Group (plus an optional kimodo Animator for ticking). Resolution
 * tiers, in order of preference:
 *
 *   1. Kimodo-rigged GLB + KimodoAnimator(mapping) + idle motion.
 *   2. Static Trellis GLB (no animation, no skeleton).
 *   3. Generic /avatar.glb fallback.
 *
 * The factory holds an internal load cache keyed by URL so multiple
 * agents using the same character GLB only fetch it once. Disposal
 * runs per-instance; templates stay in the cache for the lifetime of
 * the factory.
 *
 * Foot drop: kimodo-rigged outputs commonly hover ~0.15m above the
 * floor in our scene. We honour `mapping.metadata.footOffset` if the
 * kimodo entry provides one; otherwise fall back to KIMODO_FOOT_DROP.
 */

const KIMODO_FOOT_DROP = 0.15
// Use the animated template by default — it ships with a SkinnedMesh
// + skeleton, so we can attach a KimodoAnimator and run the shared
// idle clip on agents that don't have their own rigged model. Static
// /avatar.glb is rigid and can't animate.
const FALLBACK_AVATAR_URL = '/avatar_animated.glb'
const TARGET_HEIGHT = 0.5  // world units — matches shelterDressing primitives

// Shared radial-gradient shadow texture. Identical for every avatar,
// so we build it once and reuse the texture across instances.
let _shadowTexture = null
function shadowTexture() {
  if (_shadowTexture) return _shadowTexture
  const SIZE = 64
  const c = document.createElement('canvas')
  c.width = c.height = SIZE
  const ctx = c.getContext('2d')
  const grad = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2)
  grad.addColorStop(0,    'rgba(0, 0, 0, 0.55)')
  grad.addColorStop(0.6,  'rgba(0, 0, 0, 0.18)')
  grad.addColorStop(1,    'rgba(0, 0, 0, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, SIZE, SIZE)
  _shadowTexture = new THREE.CanvasTexture(c)
  _shadowTexture.colorSpace = THREE.SRGBColorSpace
  return _shadowTexture
}

/**
 * Flat shadow disc that lies on the floor at the wrapper's local
 * origin (= avatar's feet). Useful as a visual ground-truth marker:
 * if the disc clips through the floor or hovers above it, the
 * avatar isn't standing where its wrapper claims it is.
 */
function makeShadowDisc() {
  const geom = new THREE.PlaneGeometry(0.42, 0.42)
  const mat = new THREE.MeshBasicMaterial({
    map: shadowTexture(),
    transparent: true,
    depthWrite: false,
  })
  const disc = new THREE.Mesh(geom, mat)
  disc.rotation.x = -Math.PI / 2
  disc.position.y = 0.005   // tiny lift to avoid z-fight with the floor slab
  return disc
}

export function createAvatarFactory({ registry } = {}) {
  const draco = new DRACOLoader()
  draco.setDecoderPath('https://unpkg.com/three@0.184.0/examples/jsm/libs/draco/gltf/')
  const loader = new GLTFLoader().setDRACOLoader(draco)

  const templates = new Map()  // url → Promise<{ scene, height, feetY }>
  const instances = new Map()  // instanceId → { dispose }
  let nextInstance = 1

  const loadTemplate = (url) => {
    if (templates.has(url)) return templates.get(url)
    const p = new Promise((resolve, reject) => {
      loader.load(url, (gltf) => {
        const scene = gltf.scene
        const bbox = new THREE.Box3().setFromObject(scene)
        const size = bbox.getSize(new THREE.Vector3())
        resolve({
          scene,
          height: size.y,
          feetY: bbox.min.y,
          clips: gltf.animations ?? [],
        })
      }, undefined, reject)
    }).catch((err) => {
      // Drop failed loads so a later attempt can retry.
      templates.delete(url)
      throw err
    })
    templates.set(url, p)
    return p
  }

  // Wrap the loaded mesh in an outer Group so callers can set
  // position/rotation freely without clobbering the foot-offset that
  // lands feet at local y=0.
  //
  // We re-measure the bbox *after* scale + clone because skinned-mesh
  // clones can settle at a slightly different rest pose than the
  // template's bbox suggested — taking the load-time measurement at
  // face value made the animated avatar sink into the floor.
  const wrap = (root, scale, _feetY, extraDrop = 0, faceCamera = false) => {
    root.scale.setScalar(scale)
    if (faceCamera) root.rotation.y = Math.PI
    root.updateMatrixWorld(true)
    const liveBbox = new THREE.Box3().setFromObject(root)
    const liveFeetY = Number.isFinite(liveBbox.min.y) ? liveBbox.min.y : 0
    root.position.y = -liveFeetY - extraDrop
    const wrapper = new THREE.Group()
    wrapper.add(root)
    // Ground-truth shadow disc — sits at wrapper-local y≈0 (the
    // floor) regardless of how the avatar shifts above it.
    wrapper.add(makeShadowDisc())
    return wrapper
  }

  const buildKimodo = async (entry) => {
    const tmpl = await loadTemplate(entry.kimodoUrl)
    const root = SkeletonUtils.clone(tmpl.scene)
    const scale = tmpl.height > 0 ? TARGET_HEIGHT / tmpl.height : 1
    const footOffset = entry.mapping?.metadata?.footOffset ?? KIMODO_FOOT_DROP
    let skinned = null
    root.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o })
    let animator = null
    if (skinned && entry.mapping) {
      animator = new KimodoAnimator(skinned, {
        mapping: entry.mapping,
        scale: 1.0,
        groundOffsetY: 0,
        alignMode: 'rest',
      })
      const idle = await animationLibrary.get(animationLibrary.STANDARD_IDS.idle)
      if (idle) animator.setMotion(idle, { loop: true })
    }
    return { object3d: wrap(root, scale, tmpl.feetY, footOffset), animator, tier: 'kimodo' }
  }

  const buildStatic = async (entry) => {
    const tmpl = await loadTemplate(entry.modelUrl)
    const root = tmpl.scene.clone(true)
    const scale = tmpl.height > 0 ? TARGET_HEIGHT / tmpl.height : 1
    return { object3d: wrap(root, scale, tmpl.feetY), animator: null, tier: 'static' }
  }

  const buildFallback = async () => {
    const tmpl = await loadTemplate(FALLBACK_AVATAR_URL)
    // SkeletonUtils.clone preserves the skinned skeleton so each
    // agent can drive its own bone state.
    const root = SkeletonUtils.clone(tmpl.scene)
    const scale = tmpl.height > 0 ? TARGET_HEIGHT / tmpl.height : 1
    let skinned = null
    root.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o })
    let animator = null
    if (skinned && tmpl.clips?.length) {
      // Use the GLB's *built-in* idle clip via THREE.AnimationMixer.
      // The clip was authored for this avatar's bind pose, so feet
      // stay grounded — kimodo's motion was tuned for UniRig bones
      // and pushes mixamo hips down (avatars sink into the floor).
      const clip = tmpl.clips.find((c) => /idle/i.test(c.name)) ?? tmpl.clips[0]
      const mixer = new THREE.AnimationMixer(skinned)
      mixer.clipAction(clip).play()
      let lastTime = performance.now()
      animator = {
        update() {
          const now = performance.now()
          mixer.update((now - lastTime) / 1000)
          lastTime = now
        },
      }
    }
    return { object3d: wrap(root, scale, tmpl.feetY, 0, true), animator, tier: 'fallback' }
  }

  const spawn = async (npub) => {
    const entry = registry?.get(npub) ?? null
    let result = null
    if (entry?.kimodoUrl && entry?.mapping) {
      try { result = await buildKimodo(entry) } catch (err) {
        console.warn('[avatarFactory] kimodo load failed for', npub, err?.message || err)
      }
    }
    if (!result && entry?.modelUrl) {
      try { result = await buildStatic(entry) } catch (err) {
        console.warn('[avatarFactory] static model load failed for', npub, err?.message || err)
      }
    }
    if (!result) {
      result = await buildFallback()
    }
    const id = nextInstance++
    const handle = {
      id,
      npub,
      tier: result.tier,
      object3d: result.object3d,
      animator: result.animator,
      dispose() {
        instances.delete(id)
        result.object3d.parent?.remove(result.object3d)
        // Geometry/materials belong to the cached template — don't
        // dispose them here. SkeletonUtils.clone copies skeletons but
        // shares the underlying buffer geometry.
      },
    }
    instances.set(id, handle)
    return handle
  }

  /** Tick all live kimodo animators. Call from the render loop. */
  const tick = () => {
    for (const h of instances.values()) {
      h.animator?.update?.()
    }
  }

  const dispose = () => {
    for (const h of [...instances.values()]) h.dispose()
    instances.clear()
    templates.clear()
    try { draco.dispose() } catch {}
  }

  return { spawn, tick, dispose }
}

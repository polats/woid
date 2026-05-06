import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { Animator as KimodoAnimator } from './lib/kimodo/animator.js'

/**
 * Minimal Three.js GLB viewer. Loads the model, frames it, and lets
 * the user orbit. ResizeObserver keeps the renderer in sync with the
 * container so the same component works inside the desktop drawer
 * and on mobile fullscreen.
 *
 * Animation modes:
 *   1. GLB-bundled clips (e.g. /avatar_animated.glb) — autoplays
 *      gltf.animations[0] via THREE.AnimationMixer.
 *   2. Kimodo retargeted idle — pass `kimodoMappingUrl` (a JSON URL
 *      whose payload is the bone mapping table). The viewer fetches
 *      it plus `/api/kimodo/animations/342711ffd11f`, finds the
 *      SkinnedMesh, and attaches a KimodoAnimator. Same pipeline
 *      Shelter uses, so the asset preview matches the in-game look.
 *      `kimodoMappingUrl` takes precedence over GLB-bundled clips.
 *
 * The container's size is determined by its parent — set width/height
 * via CSS on the wrapper.
 */

const KIMODO_IDLE_ANIMATION_ID = '342711ffd11f'

export default function GlbViewer({ src, autoRotate = true, kimodoMappingUrl = null }) {
  const containerRef = useRef(null)

  useEffect(() => {
    if (!src || !containerRef.current) return
    const container = containerRef.current

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = null

    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000)
    camera.position.set(0, 0.6, 2.2)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.autoRotate = autoRotate
    controls.autoRotateSpeed = 1.2

    let model = null
    let mixer = null              // GLB-bundled clip path
    let kimodoAnimator = null     // kimodo retargeted idle path
    let kimodoSkinned = null      // cached for post-pose re-framing
    const clock = new THREE.Clock()
    let cancelled = false

    // Re-frame the camera based on whatever the model's *current*
    // bounding box says. Used once at load (rest pose) and again
    // after the kimodo idle's first pose is applied (deformed bbox)
    // so the camera doesn't crop to the legs of a retargeted mesh.
    function frameModel() {
      if (!model) return
      // For skinned meshes, computeBoundingBox iterates skinned
      // vertices via applyBoneTransform — but that reads from
      // Skeleton.boneMatrices, which only gets refreshed inside
      // WebGLRenderer.render(). At load time we haven't rendered
      // yet, so we must propagate bone world matrices and call
      // skeleton.update() ourselves; otherwise computeBoundingBox
      // silently returns the rest-pose bbox.
      let box
      if (kimodoSkinned) {
        model.updateMatrixWorld(true)         // bones live under model, not skinned
        kimodoSkinned.skeleton.update()       // bone world matrices → boneMatrices
        kimodoSkinned.computeBoundingBox()    // now reflects the current pose
        box = kimodoSkinned.boundingBox.clone().applyMatrix4(kimodoSkinned.matrixWorld)
      } else {
        box = new THREE.Box3().setFromObject(model)
      }
      const size = new THREE.Vector3()
      const center = new THREE.Vector3()
      box.getSize(size)
      box.getCenter(center)
      model.position.sub(center)
      const maxDim = Math.max(size.x, size.y, size.z) || 1
      const fov = THREE.MathUtils.degToRad(camera.fov)
      const dist = maxDim / (2 * Math.tan(fov / 2)) * 1.6
      camera.position.set(dist * 0.6, dist * 0.45, dist)
      controls.target.set(0, 0, 0)
      controls.update()
    }

    const loader = new GLTFLoader()
    loader.load(
      src,
      (gltf) => {
        if (cancelled) return
        model = gltf.scene
        scene.add(model)

        // Initial framing — uses the rest-pose bbox. For kimodo
        // retargeted meshes we re-frame again below once the idle
        // motion has set the actual pose.
        frameModel()

        if (kimodoMappingUrl) {
          // Kimodo retargeted-idle path. Find the SkinnedMesh, fetch
          // the bone mapping + the standard idle motion, attach a
          // KimodoAnimator. Mirrors avatarFactory's kimodo tier so the
          // asset preview matches what Shelter renders.
          let skinned = null
          model.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o })
          if (skinned) {
            Promise.all([
              fetch(kimodoMappingUrl).then((r) => (r.ok ? r.json() : null)),
              fetch(`/api/kimodo/animations/${KIMODO_IDLE_ANIMATION_ID}`)
                .then((r) => (r.ok ? r.json() : null)),
            ]).then(([mapping, motion]) => {
              if (cancelled || !mapping || !motion) return
              kimodoAnimator = new KimodoAnimator(skinned, {
                mapping,
                scale: 1.0,
                groundOffsetY: 0,
                alignMode: 'rest',
              })
              kimodoAnimator.setMotion(motion, { loop: true })
              kimodoSkinned = skinned
              // Run the animator once so the skeleton settles into
              // the idle pose's first frame, then re-frame off the
              // deformed bbox. frameModel() handles the bone-matrix
              // bookkeeping needed for the bbox to be accurate.
              kimodoAnimator.update()
              frameModel()
            }).catch((err) => console.warn('[GlbViewer] kimodo idle attach failed', err))
          }
        } else if (gltf.animations && gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model)
          mixer.clipAction(gltf.animations[0]).play()
        }
      },
      undefined,
      (err) => console.error('[GlbViewer] load failed', err),
    )

    function resize() {
      const w = container.clientWidth
      const h = container.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    let raf = 0
    function tick() {
      raf = requestAnimationFrame(tick)
      const dt = clock.getDelta()
      if (mixer) mixer.update(dt)
      if (kimodoAnimator) kimodoAnimator.update()
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      pmrem.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement)
      }
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose?.()
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
          for (const m of mats) {
            for (const k of Object.keys(m)) {
              const v = m[k]
              if (v && v.isTexture) v.dispose?.()
            }
            m.dispose?.()
          }
        }
      })
    }
  }, [src, autoRotate, kimodoMappingUrl])

  return <div ref={containerRef} className="glb-viewer" />
}

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/**
 * Minimal Three.js GLB viewer. Loads the model, frames it, and lets
 * the user orbit. ResizeObserver keeps the renderer in sync with the
 * container so the same component works inside the desktop drawer
 * and on mobile fullscreen.
 *
 * The container's size is determined by its parent — set width/height
 * via CSS on the wrapper.
 */
export default function GlbViewer({ src, autoRotate = true }) {
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
    let mixer = null
    const clock = new THREE.Clock()
    let cancelled = false

    const loader = new GLTFLoader()
    loader.load(
      src,
      (gltf) => {
        if (cancelled) return
        model = gltf.scene
        scene.add(model)

        // Frame the model — center it and pull the camera to fit.
        const box = new THREE.Box3().setFromObject(model)
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

        if (gltf.animations && gltf.animations.length > 0) {
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
  }, [src, autoRotate])

  return <div ref={containerRef} className="glb-viewer" />
}

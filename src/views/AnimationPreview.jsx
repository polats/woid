// Plays a kimodo animation on the male_stylized_skinned model. Same retargeting
// approach as kimodo's reference web app — vendored Animator + rigs.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { Animator } from '../lib/kimodo/animator.js'
import { MALE_STYLIZED } from '../lib/kimodo/rigs.js'

export default function AnimationPreview({ motion }) {
  const mountRef = useRef(null)
  const [error, setError] = useState(null)
  const [loaded, setLoaded] = useState(false)
  // Stash the live Animator across renders so prop changes don't tear down
  // the scene — we just call setMotion() on the existing animator.
  const animatorRef = useRef(null)

  useEffect(() => {
    if (!mountRef.current) return
    const mount = mountRef.current
    let disposed = false

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x202327)

    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.7

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50)
    camera.position.set(2.4, 1.5, 3.6)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0.9, 0)

    // Soft floor plane so motion has visual ground reference.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(3, 48),
      new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.85 }),
    )
    floor.rotation.x = -Math.PI / 2
    scene.add(floor)
    const grid = new THREE.GridHelper(6, 12, 0x4a4f5b, 0x2a2f3a)
    grid.position.y = 0.001
    scene.add(grid)

    const resize = () => {
      const w = mount.clientWidth || 320
      const h = mount.clientHeight || 240
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    let raf = 0
    const tick = () => {
      if (disposed) return
      raf = requestAnimationFrame(tick)
      controls.update()
      animatorRef.current?.update()
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(tick)

    // Load the rigged model once.
    const loader = new GLTFLoader()
    loader.load(
      MALE_STYLIZED.url,
      (gltf) => {
        if (disposed) return
        const root = gltf.scene
        scene.add(root)

        // Find the SkinnedMesh — Animator drives it via its skeleton.
        let skinned = null
        root.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o })
        if (!skinned) {
          setError('Model has no SkinnedMesh — cannot retarget.')
          return
        }

        // Anchor feet at y=0 — kimodo motion has feet at y=0 by convention.
        root.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(root)
        const groundOffsetY = -box.min.y
        root.position.y += groundOffsetY

        animatorRef.current = new Animator(skinned, {
          mapping: MALE_STYLIZED.mapping,
          scale: MALE_STYLIZED.scale,
          groundOffsetY,
          alignMode: 'rest', // skinned rigs use rest-mode by default
        })
        setLoaded(true)
      },
      undefined,
      (err) => setError(err?.message || 'Failed to load model'),
    )

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      pmrem.dispose()
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.()
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) m.dispose?.()
        }
      })
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
      animatorRef.current = null
    }
  }, [])

  // When the motion changes, push it into the existing animator.
  useEffect(() => {
    if (!loaded || !motion || !animatorRef.current) return
    animatorRef.current.setMotion(motion, { loop: true })
  }, [loaded, motion])

  return (
    <div className="anim-preview-bleed" ref={mountRef}>
      {!loaded && !error && <div className="anim-preview-hud">loading model…</div>}
      {error && <div className="anim-preview-hud anim-preview-hud-err">{error}</div>}
    </div>
  )
}

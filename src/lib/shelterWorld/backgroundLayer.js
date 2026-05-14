import * as THREE from 'three'

/**
 * Castles-style 3D backdrop. Real perspective camera + scene, composited
 * behind the dollhouse cells via a two-pass render in ShelterStage3D.
 *
 *   sky       — inverted hemisphere with vertex gradient + a sun disc
 *   clouds    — a few low-detail white blobs scattered overhead
 *   hills     — squashed hemispheres along the horizon, varied greens
 *   buildings — boxed cuboids in the middle distance with procedural
 *               window-grid textures on their walls
 *   trees     — cylinder-trunk + cone-crown set pieces between the
 *               camera and the buildings, for scale
 *   ground    — large plane at y=0 with a procedural grass canvas
 *               texture (noisy speckle so it doesn't read as flat hex)
 *   fog       — exponential, tinted to the horizon hex; pulls distant
 *               geometry toward the sky color (atmospheric perspective
 *               is the single biggest depth cue we can add cheaply)
 *
 * Lighting: hemisphere light (sky→ground tint) + a warm directional
 * "sun" + a small ambient floor. MeshLambertMaterial throughout — flat
 * enough for the cartoon look, real enough to catch the sun on roofs.
 */

// ─── Texture helpers ────────────────────────────────────────────────

function makeGroundTexture() {
  const size = 512
  const c = document.createElement('canvas')
  c.width = size; c.height = size
  const ctx = c.getContext('2d')
  // Base grass tone — slightly warmer than the previous flat hex.
  ctx.fillStyle = '#8a9476'
  ctx.fillRect(0, 0, size, size)
  // Noisy speckle so close-up the ground reads as turf, not a hex
  // panel. Mixed hues from olive to brown so it survives the warm
  // directional light.
  const speckle = ['#7e8868', '#969f7c', '#6e7858', '#4d5a3d', '#9ea38a', '#beb37a']
  for (let i = 0; i < 2400; i++) {
    ctx.fillStyle = speckle[(Math.random() * speckle.length) | 0]
    const x = Math.random() * size
    const y = Math.random() * size
    const r = Math.random() * 2.2 + 0.4
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeBuildingWallTexture({ cols = 5, rows = 10, wallHex = '#7a8390' } = {}) {
  // Cell aspect 1×2 (windows are tall). Final repeat per-building
  // is set on the texture instance to match the box's W × H.
  const w = 64, h = 128
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')
  ctx.fillStyle = wallHex
  ctx.fillRect(0, 0, w, h)
  const marginX = 4, marginY = 5
  const colW = (w - marginX * (cols + 1)) / cols
  const rowH = (h - marginY * (rows + 1)) / rows
  // Stable per-texture pseudo-random for "lit" windows. Using a fixed
  // counter (rather than Math.random) so the same wall tile looks the
  // same on every reload.
  let seed = 0xa3b1
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const lit = rnd() < 0.18
      ctx.fillStyle = lit ? '#e8d068' : '#2c343d'
      ctx.fillRect(
        marginX + col * (colW + marginX),
        marginY + r * (rowH + marginY),
        colW, rowH,
      )
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeCloudTexture() {
  const size = 256
  const c = document.createElement('canvas')
  c.width = size; c.height = size / 2
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, size, size / 2)
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  // Lump a few overlapping circles together for a soft cloud shape.
  const blobs = [
    [0.35, 0.55, 0.18],
    [0.50, 0.45, 0.22],
    [0.62, 0.55, 0.20],
    [0.45, 0.60, 0.16],
    [0.55, 0.62, 0.16],
  ]
  for (const [x, y, r] of blobs) {
    ctx.beginPath()
    ctx.arc(x * size, y * (size / 2), r * size, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// ─── Small geometry helpers ─────────────────────────────────────────

function makeTree(palette) {
  const g = new THREE.Group()
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.18, 1.0, 6),
    new THREE.MeshLambertMaterial({ color: palette.trunk }),
  )
  trunk.position.y = 0.5
  const crown = new THREE.Mesh(
    new THREE.ConeGeometry(0.75, 2.0, 7),
    new THREE.MeshLambertMaterial({ color: palette.crown }),
  )
  crown.position.y = 1.8
  g.add(trunk, crown)
  return g
}

// ─── Backdrop scene ─────────────────────────────────────────────────

export function createBackgroundLayer({ aspect = 1 } = {}) {
  const scene = new THREE.Scene()
  scene.background = null

  // Atmospheric fog tinted to the horizon. Pulls distant geometry
  // toward the sky color the further it is from the camera — the
  // single biggest depth-cue improvement on the previous version.
  scene.fog = new THREE.Fog(0xc8d2dc, 35, 180)

  // Perspective camera — sits on the world's y=0 line so the horizon
  // matches the main scene's surface strip.
  const camera = new THREE.PerspectiveCamera(38, aspect, 0.5, 500)
  camera.position.set(0, 0, 28)
  camera.lookAt(0, 0, 0)

  // ── Lighting ─────────────────────────────────────────────────────
  // Hemisphere light blends sky-blue from above with warm-earth from
  // below, so curved surfaces get a free gradient that ambient alone
  // can't supply. Directional "sun" warms one side of every box.
  // Small ambient pulls shadow areas off pitch-black.
  // Night palette — cool blue sky tint above, near-black ground.
  // Sun → moonlight (pale cool blue-white) at low intensity.
  const hemi = new THREE.HemisphereLight(0x4a5e84, 0x1a1c24, 0.35)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xb0c8e8, 0.45)
  sun.position.set(45, 70, 25)
  scene.add(sun)

  scene.add(new THREE.AmbientLight(0xffffff, 0.08))

  // ── Sky hemisphere ───────────────────────────────────────────────
  {
    const radius = 200
    const geo = new THREE.SphereGeometry(radius, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2)
    const top = new THREE.Color('#0c1424')
    const horizon = new THREE.Color('#2a364a')
    const positions = geo.attributes.position
    const colors = new Float32Array(positions.count * 3)
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i)
      const t = Math.pow(Math.max(0, Math.min(1, y / radius)), 0.55)
      const c = horizon.clone().lerp(top, t)
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,        // sky shouldn't fade into its own fog colour
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.name = 'backdrop:sky'
    scene.add(mesh)
  }

  // ── Moon disc on the skydome (was sun, swapped for the night palette) ─
  {
    const geo = new THREE.CircleGeometry(5, 24)
    const mat = new THREE.MeshBasicMaterial({
      color: 0xe6ecf4, transparent: true, opacity: 0.85, fog: false, depthWrite: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    // Pinned roughly where the directional light points from. Sits
    // far enough back that perspective scales it correctly.
    mesh.position.set(80, 60, -180)
    mesh.lookAt(0, 0, 0)
    scene.add(mesh)
  }

  // ── Clouds (sparse, overhead, billboarded toward the camera) ────
  const cloudTex = makeCloudTexture()
  {
    const cloudMat = new THREE.MeshBasicMaterial({
      map: cloudTex, color: 0x6a7488, transparent: true, depthWrite: false, fog: true, opacity: 0.55,
    })
    const count = 7
    for (let i = 0; i < count; i++) {
      const w = 22 + Math.abs(Math.sin(i * 1.9)) * 18
      const h = w * 0.4
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), cloudMat)
      const t = i / (count - 1)
      mesh.position.set(
        (t - 0.5) * 160,
        25 + Math.sin(i * 1.3) * 8,
        -90 - Math.cos(i * 1.7) * 20,
      )
      mesh.lookAt(0, mesh.position.y, 0)
      scene.add(mesh)
    }
  }

  // ── Ground plane with grass texture ──────────────────────────────
  {
    const groundTex = makeGroundTexture()
    groundTex.repeat.set(60, 60)
    const geo = new THREE.PlaneGeometry(600, 600)
    geo.rotateX(-Math.PI / 2)
    const mat = new THREE.MeshLambertMaterial({ map: groundTex })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.y = 0
    mesh.name = 'backdrop:ground'
    scene.add(mesh)
  }

  // ── Distant hills ────────────────────────────────────────────────
  const hillsLayer = new THREE.Group()
  hillsLayer.name = 'backdrop:hills'
  {
    const palette = ['#4a5c40', '#3d4a35', '#54664b', '#3b4732']
    const total = 14
    for (let i = 0; i < total; i++) {
      const r = 18 + Math.abs(Math.sin(i * 1.9)) * 14
      const geo = new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)
      const mat = new THREE.MeshLambertMaterial({ color: palette[i % palette.length] })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.scale.y = 0.45 + (Math.abs(Math.sin(i * 1.3)) * 0.2)
      const t = (i + 0.5) / total - 0.5
      mesh.position.set(
        t * 260 + Math.sin(i * 2.1) * 6,
        0,
        -90 - Math.abs(Math.cos(i * 1.7)) * 30,
      )
      hillsLayer.add(mesh)
    }
  }
  scene.add(hillsLayer)

  // ── Distant building boxes with window textures ──────────────────
  const buildingsLayer = new THREE.Group()
  buildingsLayer.name = 'backdrop:buildings'
  {
    const wallPalette = ['#7a8390', '#8e96a0', '#5d6772', '#a09a8a']
    const roofPalette = ['#4a525c', '#6e6258', '#3f4750']
    const total = 22
    for (let i = 0; i < total; i++) {
      const t = i / (total - 1)
      const w = 3 + Math.abs(Math.sin(i * 1.7)) * 4
      const h = 7 + Math.abs(Math.sin(i * 2.3)) * 12
      const d = 2.4 + Math.abs(Math.sin(i * 3.1)) * 2.6
      const wallHex = wallPalette[i % wallPalette.length]
      const wallTex = makeBuildingWallTexture({ wallHex })
      // Repeat the tile so each visible window cell is roughly square
      // on screen regardless of the box's W × H.
      wallTex.repeat.set(Math.max(1, w / 3), Math.max(1, h / 3))
      const wallMat = new THREE.MeshLambertMaterial({ map: wallTex })
      const roofMat = new THREE.MeshLambertMaterial({
        color: roofPalette[i % roofPalette.length],
      })
      // Box face order: +x, -x, +y, -y, +z, -z. Walls take the
      // textured material; top + bottom take a flat roof tone.
      const mats = [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat]
      const geo = new THREE.BoxGeometry(w, h, d)
      const mesh = new THREE.Mesh(geo, mats)
      mesh.position.set(
        (t - 0.5) * 220,
        h / 2,
        -45 - Math.abs(Math.sin(i * 1.3)) * 22,
      )
      mesh.rotation.y = Math.sin(i * 0.7) * 0.25
      buildingsLayer.add(mesh)
    }
  }
  scene.add(buildingsLayer)

  // ── Trees (foreground scale anchor) ──────────────────────────────
  const treesLayer = new THREE.Group()
  treesLayer.name = 'backdrop:trees'
  {
    const treePalettes = [
      { trunk: '#4a3424', crown: '#3a5034' },
      { trunk: '#3e2c1c', crown: '#445d3a' },
      { trunk: '#5a4232', crown: '#324a2c' },
    ]
    const count = 14
    for (let i = 0; i < count; i++) {
      const tree = makeTree(treePalettes[i % treePalettes.length])
      const t = i / (count - 1)
      // Spread across the visible width, biased away from x=0 so the
      // shelter has clearance. Range chosen so trees occupy the mid
      // ground between buildings and camera.
      const x = (t - 0.5) * 60 + (Math.sin(i * 5.3) * 6)
      const z = -18 - Math.abs(Math.sin(i * 1.7)) * 14
      tree.position.set(x, 0, z)
      const s = 1 + Math.abs(Math.sin(i * 2.7)) * 0.6
      tree.scale.setScalar(s)
      tree.rotation.y = Math.sin(i * 0.9) * 0.5
      treesLayer.add(tree)
    }
  }
  scene.add(treesLayer)

  let parallaxX = 1.0
  let parallaxY = 1.0
  const baseY = camera.position.y

  return {
    render(renderer, mainCamera) {
      camera.position.x = mainCamera.position.x * parallaxX
      camera.position.y = baseY + mainCamera.position.y * parallaxY
      camera.lookAt(camera.position.x, camera.position.y, 0)
      renderer.render(scene, camera)
    },
    setAspect(a) {
      if (!Number.isFinite(a) || a <= 0) return
      camera.aspect = a
      camera.updateProjectionMatrix()
    },
    setParallax({ x, y } = {}) {
      if (typeof x === 'number') parallaxX = x
      if (typeof y === 'number') parallaxY = y
    },
    setWidth() {},
    updateParallax() {},
    dispose() {
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.()
        if (Array.isArray(o.material)) {
          o.material.forEach((m) => {
            m.map?.dispose?.()
            m.dispose?.()
          })
        } else if (o.material) {
          o.material.map?.dispose?.()
          o.material.dispose?.()
        }
      })
    },
  }
}

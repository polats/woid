/**
 * Pan / zoom controls for an orthographic camera.
 *
 * - Drag (mouse or single-finger touch) → translate camera in XY.
 * - Wheel → zoom toward cursor.
 * - Two-finger pinch → zoom toward midpoint.
 *
 * The camera's frustum (left/right/top/bottom) is owned by the caller
 * and re-set on resize; this module only mutates `camera.zoom` and
 * `camera.position`. Zoom and pan are clamped to a world bounding
 * rect so the user can't lose the diorama off-screen.
 */
export function createPanZoomControls(camera, domElement, opts = {}) {
  let minZoom = opts.minZoom ?? 0.5
  let maxZoom = opts.maxZoom ?? 8
  // Bounding rect for the camera centre in world XY. Shrink-to-fit
  // happens in clamp() — caller passes the world rect of the diorama.
  let bounds = opts.bounds ?? { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  // Fired whenever the user drags, wheels, or pinches — used by the
  // caller to cancel any in-flight camera tween.
  const onUserInput = opts.onUserInput ?? (() => {})
  // Fired when the pointer drags while a modifier (ctrl / meta) is
  // held. Suppresses normal pan for that move so callers can wire the
  // delta into a debug rotation, etc. Mouse-only — touch has no modifier.
  const onModifierDrag = opts.onModifierDrag ?? null

  // Lock state — when active, camera.y is forced to `lockY`, vertical
  // drag is suppressed, wheel/pinch zoom is disabled. A wheel-out or
  // significant pinch-out fires `onExitLock` instead of zooming.
  let lockY = null
  let lockZoom = false
  let onExitLock = () => {}

  let dragging = false
  let lastX = 0
  let lastY = 0
  // Pinch state
  let pinching = false
  let pinchStartDist = 0
  let pinchStartZoom = 1

  const ndc = (clientX, clientY) => {
    const r = domElement.getBoundingClientRect()
    return {
      x: ((clientX - r.left) / r.width) * 2 - 1,
      y: -((clientY - r.top) / r.height) * 2 + 1,
    }
  }

  // World point under a screen NDC for the current camera state.
  const worldAt = (n) => {
    const halfW = (camera.right - camera.left) / 2 / camera.zoom
    const halfH = (camera.top - camera.bottom) / 2 / camera.zoom
    return {
      x: camera.position.x + n.x * halfW,
      y: camera.position.y + n.y * halfH,
    }
  }

  const clamp = () => {
    camera.zoom = Math.max(minZoom, Math.min(maxZoom, camera.zoom))
    camera.position.x = Math.max(bounds.minX, Math.min(bounds.maxX, camera.position.x))
    camera.position.y = Math.max(bounds.minY, Math.min(bounds.maxY, camera.position.y))
    if (lockY !== null) camera.position.y = lockY
    camera.updateProjectionMatrix()
  }

  // Apply a zoom factor while keeping the world point under (clientX,
  // clientY) anchored — that's what makes wheel/pinch zoom feel right.
  const zoomAt = (factor, clientX, clientY) => {
    const n = ndc(clientX, clientY)
    const before = worldAt(n)
    camera.zoom = Math.max(minZoom, Math.min(maxZoom, camera.zoom * factor))
    const after = worldAt(n)
    camera.position.x += before.x - after.x
    camera.position.y += before.y - after.y
    clamp()
  }

  const onPointerDown = (e) => {
    if (e.pointerType === 'touch') return // touch handled separately
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    domElement.setPointerCapture?.(e.pointerId)
    onUserInput()
  }
  const onPointerMove = (e) => {
    if (!dragging) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    if (onModifierDrag && (e.ctrlKey || e.metaKey)) {
      onModifierDrag(dx, dy)
      return
    }
    // Convert pixel delta to world delta using current zoom.
    const r = domElement.getBoundingClientRect()
    const worldPerPxX = (camera.right - camera.left) / camera.zoom / r.width
    const worldPerPxY = (camera.top - camera.bottom) / camera.zoom / r.height
    camera.position.x -= dx * worldPerPxX
    camera.position.y += dy * worldPerPxY
    clamp()
  }
  const onPointerUp = (e) => {
    dragging = false
    domElement.releasePointerCapture?.(e.pointerId)
  }
  const onWheel = (e) => {
    e.preventDefault()
    const factor = Math.exp(-e.deltaY * 0.0015)
    if (lockZoom) {
      if (factor < 1) onExitLock()
      return
    }
    zoomAt(factor, e.clientX, e.clientY)
    onUserInput()
  }

  // Touch — single finger pans, two fingers pinch-zoom.
  const touches = new Map()
  const onTouchStart = (e) => {
    for (const t of e.changedTouches) {
      touches.set(t.identifier, { x: t.clientX, y: t.clientY })
    }
    onUserInput()
    if (touches.size === 1) {
      dragging = true
      const t = e.touches[0]
      lastX = t.clientX
      lastY = t.clientY
    } else if (touches.size === 2) {
      dragging = false
      pinching = true
      const [a, b] = [...e.touches]
      pinchStartDist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
      pinchStartZoom = camera.zoom
    }
  }
  const onTouchMove = (e) => {
    e.preventDefault()
    if (pinching && e.touches.length >= 2) {
      const [a, b] = [...e.touches]
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
      const cx = (a.clientX + b.clientX) / 2
      const cy = (a.clientY + b.clientY) / 2
      if (lockZoom) {
        const ratio = dist / pinchStartDist
        if (ratio < 0.85) onExitLock()
        return
      }
      const targetZoom = Math.max(minZoom, Math.min(maxZoom, pinchStartZoom * (dist / pinchStartDist)))
      const factor = targetZoom / camera.zoom
      zoomAt(factor, cx, cy)
    } else if (dragging && e.touches.length === 1) {
      const t = e.touches[0]
      const dx = t.clientX - lastX
      const dy = t.clientY - lastY
      lastX = t.clientX
      lastY = t.clientY
      const r = domElement.getBoundingClientRect()
      const worldPerPxX = (camera.right - camera.left) / camera.zoom / r.width
      const worldPerPxY = (camera.top - camera.bottom) / camera.zoom / r.height
      camera.position.x -= dx * worldPerPxX
      camera.position.y += dy * worldPerPxY
      clamp()
    }
  }
  const onTouchEnd = (e) => {
    for (const t of e.changedTouches) touches.delete(t.identifier)
    if (touches.size < 2) pinching = false
    if (touches.size === 0) dragging = false
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointermove', onPointerMove)
  domElement.addEventListener('pointerup', onPointerUp)
  domElement.addEventListener('pointercancel', onPointerUp)
  domElement.addEventListener('wheel', onWheel, { passive: false })
  domElement.addEventListener('touchstart', onTouchStart, { passive: false })
  domElement.addEventListener('touchmove', onTouchMove, { passive: false })
  domElement.addEventListener('touchend', onTouchEnd)
  domElement.addEventListener('touchcancel', onTouchEnd)

  return {
    setBounds(next) { bounds = next; clamp() },
    setLimits({ minZoom: nMin, maxZoom: nMax } = {}) {
      if (typeof nMin === 'number') minZoom = nMin
      if (typeof nMax === 'number') maxZoom = nMax
      clamp()
    },
    setLock({ y = null, zoom = false, onExit = () => {} } = {}) {
      lockY = y
      lockZoom = zoom
      onExitLock = onExit
      clamp()
    },
    dispose() {
      domElement.removeEventListener('pointerdown', onPointerDown)
      domElement.removeEventListener('pointermove', onPointerMove)
      domElement.removeEventListener('pointerup', onPointerUp)
      domElement.removeEventListener('pointercancel', onPointerUp)
      domElement.removeEventListener('wheel', onWheel)
      domElement.removeEventListener('touchstart', onTouchStart)
      domElement.removeEventListener('touchmove', onTouchMove)
      domElement.removeEventListener('touchend', onTouchEnd)
      domElement.removeEventListener('touchcancel', onTouchEnd)
    },
  }
}

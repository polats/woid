import { useEffect, useRef, useState } from 'react'

/**
 * Atmospheric overlay for the Crack cinematic.
 *
 * The cracks themselves now live in the 3D scene (shader on the
 * underground fill mesh — see `crackShader.js`). This overlay is
 * only the cinematographic chrome that wouldn't make sense in
 * 3D: a brief impact flash at the strike beat, ambient dust, and
 * a vignette to focus the eye on the lower band.
 */
export default function CrackCinematicOverlay() {
  const [t, setT] = useState(0)
  const startRef = useRef(0)
  useEffect(() => {
    startRef.current = performance.now()
    let raf
    const tick = (now) => {
      setT(now - startRef.current)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Single, punchy flash at the strike — aligns with the moment
  // the crack shader starts ramping uProgress (descent start + 2s
  // reveal delay = 4.1s into the cinematic).
  const T_FLASH = 4050
  const flashAge = t - T_FLASH
  const flash = flashAge < 0
    ? 0
    : flashAge < 80
      ? flashAge / 80
      : flashAge < 360
        ? 1 - (flashAge - 80) / 280
        : 0

  // Final fade so the overlay leaves cleanly.
  const T_FADE_START = 11200
  const T_FADE_LEN = 1300
  const fadeOut = clamp(1 - (t - T_FADE_START) / T_FADE_LEN, 0, 1)

  return (
    <div className="crack-cinematic" style={{ opacity: fadeOut }} aria-hidden>
      <div className="crack-cinematic-flash" style={{ opacity: flash }} />
      <div className="crack-cinematic-dust" />
      <div className="crack-cinematic-vignette" />
    </div>
  )
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

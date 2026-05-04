import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Modal image viewer. Click an avatar or T-pose thumbnail in the
 * Assets tab to render this overlay; close via the × button (top
 * right), Escape, or clicking the backdrop.
 *
 * Renders via React portal into document.body so it escapes any
 * parent stacking context (z-index alone isn't enough — parents
 * like the agent drawer use clip-path animations + transforms
 * that establish their own stacking contexts and trap children
 * inside them regardless of z-index).
 */
export default function Lightbox({ src, alt, onClose }) {
  useEffect(() => {
    if (!src) return
    function onKey(e) { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    // Lock body scroll while open.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [src, onClose])

  if (!src) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="lightbox-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'image preview'}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={(e) => { e.stopPropagation(); onClose?.() }}
        aria-label="close"
      >
        ×
      </button>
      <img
        src={src}
        alt={alt || ''}
        className="lightbox-image"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  )
}

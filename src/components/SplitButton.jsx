import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Split button: a primary action (left) plus a small caret button
 * (right) that opens a dropdown of alternative options. Mirrors the
 * shape used in `Regenerate ▾` patterns elsewhere — clicking the main
 * button runs the currently-selected option, clicking the caret picks
 * a different one. Pure render component; the parent owns selection
 * state.
 *
 * Props:
 *   options:   [{ id, label, description?, disabled? }]
 *   selectedId: id of the currently-selected option
 *   onSelect(id): user picked a different option
 *   onAction(option): main button (or option click) — passes the
 *                     resolved option object for convenience
 *   primary:   bool — primary button styling on the action
 *   disabled:  bool — disable the whole control while in flight
 *   children:  the action button label
 */
export default function SplitButton({
  options,
  selectedId,
  onSelect,
  onAction,
  primary = false,
  disabled = false,
  children,
  title,
}) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState(null)  // { top, left, width } in viewport px
  const containerRef = useRef(null)
  const menuRef = useRef(null)

  // Track the trigger's viewport rect every frame while open. rAF
  // polling beats scroll/resize listeners alone because sidebar
  // collapse, drawer animations, and other transition-driven layout
  // shifts don't fire either of those — but the next paint always
  // updates getBoundingClientRect.
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return
    let raf
    function loop() {
      const r = containerRef.current?.getBoundingClientRect()
      if (r) {
        const margin = 8
        const minWidth = Math.max(r.width, 240)
        // Vertical placement — flip up if not enough room below.
        const spaceBelow = window.innerHeight - r.bottom - margin
        const spaceAbove = r.top - margin
        const flipUp = spaceBelow < 180 && spaceAbove > spaceBelow
        const maxHeight = Math.max(120, flipUp ? spaceAbove : spaceBelow)
        // Horizontal placement — default right-align (menu's right edge
        // matches trigger's right edge). If that would push the menu's
        // left edge off-screen, flip to left-align so it opens
        // rightward from the trigger's left edge.
        const fitsRightAlign = r.right >= minWidth + margin
        const next = {
          top: flipUp ? null : r.bottom + 4,
          bottom: flipUp ? window.innerHeight - r.top + 4 : null,
          right: fitsRightAlign ? Math.max(margin, window.innerWidth - r.right) : null,
          left: fitsRightAlign ? null : Math.max(margin, r.left),
          minWidth,
          maxHeight,
        }
        setMenuPos((prev) => {
          if (
            prev
            && prev.top === next.top
            && prev.bottom === next.bottom
            && prev.right === next.right
            && prev.left === next.left
            && prev.minWidth === next.minWidth
            && prev.maxHeight === next.maxHeight
          ) return prev
          return next
        })
      }
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      const inTrigger = containerRef.current?.contains(e.target)
      const inMenu = menuRef.current?.contains(e.target)
      if (!inTrigger && !inMenu) setOpen(false)
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = options.find((o) => o.id === selectedId) || options[0] || null

  return (
    <div className="split-btn" ref={containerRef}>
      <button
        type="button"
        className={`split-btn-main npcs-btn${primary ? ' primary' : ''}`}
        disabled={disabled}
        onClick={() => onAction?.(selected)}
        title={title}
      >
        {children}
      </button>
      <button
        type="button"
        className={`split-btn-caret npcs-btn${primary ? ' primary' : ''}`}
        disabled={disabled}
        aria-label="Pick model"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open && menuPos && createPortal(
        <ul
          ref={menuRef}
          className="split-btn-menu split-btn-menu-portal"
          role="menu"
          style={{
            position: 'fixed',
            top: menuPos.top ?? undefined,
            bottom: menuPos.bottom ?? undefined,
            right: menuPos.right ?? undefined,
            left: menuPos.left ?? undefined,
            minWidth: menuPos.minWidth,
            maxHeight: menuPos.maxHeight,
            overflowY: 'auto',
          }}
        >
          {options.map((o) => {
            const active = o.id === selectedId
            return (
              <li key={o.id} role="menuitem">
                <button
                  type="button"
                  className={`split-btn-menu-item${active ? ' active' : ''}`}
                  disabled={o.disabled}
                  onClick={() => {
                    onSelect?.(o.id)
                    setOpen(false)
                  }}
                  title={o.description || ''}
                >
                  <span className="split-btn-menu-tick">{active ? '✓' : ''}</span>
                  <span className="split-btn-menu-label">{o.label}</span>
                  {o.disabled && <span className="split-btn-menu-disabled">(unavailable)</span>}
                </button>
              </li>
            )
          })}
        </ul>,
        document.body,
      )}
    </div>
  )
}

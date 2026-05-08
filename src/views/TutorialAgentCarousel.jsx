import { useEffect, useState } from 'react'
import config from '../config.js'

// One placeholder personality tag per visible card slot — different
// per starter so the cards differentiate visually. Until the bridge
// surfaces real character tags this list stands in.
const PLACEHOLDER_TAGS = [
  'thoughtful',
  'meticulous',
  'curious',
  'steady',
]

/**
 * Slides in below the tutorial dialog and shows a deck of agent cards
 * (currently sourced from kind:'player' starter-tagged characters)
 * that the player can browse with folder-style tabs at the top.
 *
 * Mirrors the visual language of the in-game character card: paper +
 * ink portrait + name + bio, with stacked folder tabs sticking out
 * the top of the card. The deck is purely informational — it doesn't
 * spawn or recruit; that comes later in the tutorial.
 *
 * Props:
 *   visible — caller-controlled mount/animate flag (true = slide in)
 *   onTapToAdvance — called when the player taps the layer to dismiss
 *
 * Loads characters lazily on first show. Filters to `starter:true`
 * server-side via the `kind=player` listing (the bridge already
 * carries `starter` per character) so we don't paginate the whole
 * sandbox roster client-side.
 */
export default function TutorialAgentCarousel({ visible, onHire }) {
  const [chars, setChars] = useState(null)
  const [error, setError] = useState(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const cfg = config.agentSandbox || {}

  useEffect(() => {
    if (!visible || chars !== null) return
    if (!cfg.bridgeUrl) { setError('bridge unavailable'); return }
    let cancelled = false
    fetch(`${cfg.bridgeUrl}/characters?kind=player`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (cancelled) return
        const list = (j?.characters ?? []).filter((c) => c.starter).slice(0, 3)
        setChars(list)
      })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)) })
    return () => { cancelled = true }
  }, [visible, chars, cfg.bridgeUrl])

  // Stay mounted briefly after `visible` flips to false so the CSS
  // slide-down transition has time to play before unmounting. Same
  // pattern the dialog uses for its fade.
  const [mounted, setMounted] = useState(visible)
  useEffect(() => {
    if (visible) { setMounted(true); return }
    if (!mounted) return
    const id = setTimeout(() => setMounted(false), 380)
    return () => clearTimeout(id)
  }, [visible, mounted])

  if (!mounted) return null

  const active = chars?.[activeIdx] ?? null
  const initial = (active?.name || '?').slice(0, 1).toUpperCase()

  return (
    <div className={`tutorial-carousel${visible ? ' visible' : ''}`}>
      {/* Folder tabs — one per starter, stylistically extending out of
          the top of the card. The active tab joins seamlessly with the
          card body below it. Tapping a tab swaps the visible card. */}
      {chars && chars.length > 0 && (
        <nav className="tutorial-carousel-tabs" role="tablist">
          {chars.map((c, i) => (
            <button
              key={c.pubkey}
              type="button"
              role="tab"
              aria-selected={i === activeIdx}
              className={`tutorial-carousel-tab${i === activeIdx ? ' active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setActiveIdx(i) }}
            >
              {c.name || c.pubkey.slice(0, 6)}
            </button>
          ))}
        </nav>
      )}

      <div
        className="tutorial-carousel-card"
        onClick={(e) => {
          // Tapping the card itself doesn't advance — only an explicit
          // tap on empty space (handled by the parent overlay) or the
          // chevron ends the action. This lets the player explore the
          // tabs without accidentally dismissing.
          e.stopPropagation()
        }}
      >
        {chars === null && !error && (
          <p className="tutorial-carousel-empty">Loading recruits…</p>
        )}
        {error && (
          <p className="tutorial-carousel-empty">Could not load recruits ({error}).</p>
        )}
        {chars && chars.length === 0 && (
          <p className="tutorial-carousel-empty">
            No starter agents tagged yet. Open the agent sandbox and check the Starter box on a few players.
          </p>
        )}
        {active && (
          // Key on pubkey so swapping tabs unmounts/remounts the
          // contents and re-runs the swap animation defined in CSS.
          <div className="tutorial-carousel-card-inner" key={active.pubkey}>
            <div className="tutorial-carousel-portrait">
              {active.avatarUrl
                ? <img src={active.avatarUrl} alt={active.name} />
                : <span>{initial}</span>}
            </div>
            <div className="tutorial-carousel-meta">
              <div className="tutorial-carousel-name-row">
                <strong>{active.name || '—'}</strong>
                <StarRating value={1} />
              </div>
              {active.about && <p>{active.about}</p>}
              <ul className="tutorial-carousel-tags">
                <li>{PLACEHOLDER_TAGS[activeIdx] ?? PLACEHOLDER_TAGS[0]}</li>
              </ul>
              <button
                type="button"
                className="tutorial-carousel-hire"
                onClick={(e) => { e.stopPropagation(); onHire?.(active) }}
              >
                Hire
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StarRating({ value }) {
  const v = Math.max(1, Math.min(5, Math.round(value || 0)))
  return (
    <span className="tutorial-carousel-stars" aria-label={`${v} out of 5`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={i < v ? 'on' : ''} aria-hidden="true">★</span>
      ))}
    </span>
  )
}

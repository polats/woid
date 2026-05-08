import { useSyncExternalStore, useEffect, useState } from 'react'
import { subscribe, getState, tap, setHired } from '../lib/tutorial/runtime.js'
import TutorialAgentCarousel from './TutorialAgentCarousel.jsx'

const DIALOG_FADE_MS = 320

/**
 * Renders the tutorial scrim, dialog box, and tap-to-advance chevron.
 * Subscribes to the tutorial runtime and toggles a `tutorial-hud-hidden`
 * class on the host element so the tab bar / status bar can fade out
 * via CSS while a step is running.
 *
 * Dialog dismissal: when the runtime clears `dialog` (after a tap),
 * we keep the previous dialog data mounted with a `.fading` class for
 * DIALOG_FADE_MS so CSS can animate the fade-out instead of the box
 * disappearing instantly.
 */
export default function TutorialOverlay() {
  const t = useSyncExternalStore(subscribe, getState)

  useEffect(() => {
    document.body.classList.toggle('tutorial-hud-hidden', !!t.hudHidden)
    return () => document.body.classList.remove('tutorial-hud-hidden')
  }, [t.hudHidden])

  // Track the dialog payload separately so we can render it briefly
  // after the runtime nulls it out — that keeps the fade animation
  // visible. `fading` flips when the runtime's dialog → null.
  const [shownDialog, setShownDialog] = useState(t.dialog)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    if (t.dialog) {
      setShownDialog(t.dialog)
      setFading(false)
    } else if (shownDialog) {
      setFading(true)
      const id = setTimeout(() => {
        setShownDialog(null)
        setFading(false)
      }, DIALOG_FADE_MS)
      return () => clearTimeout(id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.dialog])

  if (!t.active && t.overlayAlpha === 0 && !shownDialog && !t.carousel) return null

  const speakerInitial = (shownDialog?.speakerName || '?').slice(0, 1).toUpperCase()

  // While the carousel is up, the dialog advances via the per-card
  // Hire button only — disable both the layer-wide tap target and the
  // bobbing chevron so the player can interact with tabs and cards
  // without accidentally dismissing.
  const carouselOpen = !!t.carousel
  const acceptLayerTap = t.awaitingTap && !carouselOpen
  const onLayerClick = acceptLayerTap ? tap : undefined

  return (
    <div
      className={`tutorial-layer${acceptLayerTap ? ' awaiting-tap' : ''}${carouselOpen ? ' has-carousel' : ''}`}
      onClick={onLayerClick}
      role={acceptLayerTap ? 'button' : undefined}
      aria-label={acceptLayerTap ? 'Tap to continue' : undefined}
    >
      {t.overlayAlpha > 0 && (
        <div
          className="tutorial-scrim"
          style={{ opacity: t.overlayAlpha }}
          aria-hidden="true"
        />
      )}

      <TutorialAgentCarousel
        visible={!!t.carousel}
        onHire={(active) => {
          // Record which carousel card was selected so later actions
          // (walkInHired) know whose avatar to animate. Then advance.
          if (active?.pubkey) setHired(active.pubkey)
          tap()
        }}
      />

      {shownDialog && (
        <div
          className={`tutorial-dialog${fading ? ' fading' : ''}${t.carousel ? ' with-carousel' : ''}`}
          role="dialog"
          aria-live="polite"
        >
          <div className="tutorial-dialog-portrait">
            {shownDialog.speakerAvatarUrl
              ? <img src={shownDialog.speakerAvatarUrl} alt="" />
              : <span>{speakerInitial}</span>}
          </div>
          {/* Key on the text so React remounts this subtree when the
              dialog content changes (e.g. between Edi's two lines).
              That re-triggers the appear animation without having to
              fully tear down the surrounding dialog box. */}
          <div className="tutorial-dialog-text" key={shownDialog.text}>
            <strong>{shownDialog.speakerName}</strong>
            <p>{shownDialog.text}</p>
          </div>
          {t.awaitingTap && !carouselOpen && (
            <div className="tutorial-tap-hint" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
                stroke="currentColor" strokeWidth="2.4"
                strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

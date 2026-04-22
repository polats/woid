import { useEffect, useRef, useState } from 'react'
import AgentProfile from './AgentProfile.jsx'
import AgentInspector from './AgentInspector.jsx'

/**
 * Left-slide drawer with vertical side-tabs hosting:
 *   · Profile — edit persona, regenerate avatar/bio
 *   · Context — turn waterfall (snapshot of past pi sessions)
 *   · Live    — streaming SSE events from the running runtime, plus
 *               the raw toggle for debug inspection
 *
 * Open state is owned by Sandbox.inspectedId; this component just
 * renders the active tab. Dismiss: close button, dimmer click, or
 * any mousedown outside the aside. A `closing` state plays the
 * exit animation before we call parent `onClose`.
 */
export default function AgentDrawer({ bridgeUrl, character, agent, initialTab = 'context', onClose, onDeleted, onUpdated }) {
  const [tab, setTab] = useState(initialTab)
  const [closing, setClosing] = useState(false)
  const asideRef = useRef(null)
  const closingRef = useRef(false)

  const prevPubkeyRef = useRef(character?.pubkey)
  useEffect(() => {
    if (prevPubkeyRef.current !== character?.pubkey) {
      prevPubkeyRef.current = character?.pubkey
      setTab(initialTab)
    }
  }, [character?.pubkey, initialTab])

  // Wraps the parent's onClose with a timed exit animation so the
  // slide-out + fade actually show. `closing` triggers the .closing
  // CSS class; after the animation completes we unmount by calling
  // the parent's onClose which clears inspectedId.
  const EXIT_MS = 180
  function dismiss() {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    setTimeout(() => onClose?.(), EXIT_MS)
  }

  const name = character?.name ?? agent?.name ?? '—'
  const npub = character?.npub ?? agent?.npub ?? ''
  const model = agent?.model ?? character?.model ?? null

  return (
    <>
      <aside
        className={`agent-drawer${closing ? ' closing' : ''}`}
        ref={asideRef}
      >
        <nav className="agent-drawer-sidetabs" role="tablist">
          <button
            className={`agent-drawer-sidetab${tab === 'profile' ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === 'profile'}
            onClick={() => setTab('profile')}
            title="Profile"
          >
            <IconProfile />
            <span>Profile</span>
          </button>
          <button
            className={`agent-drawer-sidetab${tab === 'context' ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === 'context'}
            onClick={() => setTab('context')}
            title="Context — turn history"
          >
            <IconContext />
            <span>Context</span>
          </button>
          <button
            className={`agent-drawer-sidetab${tab === 'live' ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === 'live'}
            onClick={() => setTab('live')}
            title="Live — streaming events"
          >
            <IconLive />
            <span>Live</span>
          </button>
        </nav>

        <div className="agent-drawer-main">
          <header className="agent-drawer-head">
            <div className="agent-drawer-avatar">
              {character?.avatarUrl ? (
                <img src={character.avatarUrl} alt={name} />
              ) : (
                <span>{(name || '?').trim().charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className="agent-drawer-title">
              <strong>{name}</strong>
              {model && (
                <span className="agent-model-badge" title={model}>{model.split('/').pop()}</span>
              )}
              <code title={npub}>{npub ? npub.slice(0, 12) + '…' : ''}</code>
            </div>
            <button className="agent-drawer-close" onClick={dismiss} aria-label="close">×</button>
          </header>

          <div className="agent-drawer-panel" role="tabpanel">
            {tab === 'profile' ? (
              character?.pubkey ? (
                <AgentProfile
                  pubkey={character.pubkey}
                  onClose={dismiss}
                  onDeleted={onDeleted}
                  onUpdated={onUpdated}
                />
              ) : (
                <p className="muted" style={{ padding: 14 }}>No character loaded.</p>
              )
            ) : agent ? (
              <AgentInspector bridgeUrl={bridgeUrl} agent={agent} view={tab} />
            ) : (
              <p className="muted" style={{ padding: 14 }}>
                This character is not running. Drag them onto the map to spawn.
              </p>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

/* ────── Brand icons ──────
   Monochrome, thick-stroke, paper-and-ink aesthetic to match the rest
   of the UI. Inherit currentColor so they flip with tab active state. */

function IconProfile() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4.5 5-6.5 8-6.5s6.5 2 8 6.5" />
    </svg>
  )
}

function IconContext() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="1" />
      <path d="M7 9h10M7 13h10M7 17h6" />
    </svg>
  )
}

function IconLive() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <path d="M6 6a8 8 0 000 12M18 6a8 8 0 010 12" />
      <path d="M3 3a12 12 0 000 18M21 3a12 12 0 010 18" />
    </svg>
  )
}

import { useEffect, useState, useSyncExternalStore } from 'react'
import * as tposeStore from './lib/tposeStore.js'

/**
 * Assets tab — derivative imagery and rigs for a character.
 *
 * Pipeline: avatar → T-pose reference → 3D model (rigged + animated).
 * Each stage feeds the next; later stages render as placeholders until
 * implemented. T-pose generation runs on the self-hosted FLUX.1-Kontext
 * Cloud Run service.
 *
 * Generation state lives in tposeStore (module-scoped, keyed by pubkey)
 * so an in-flight request survives switching drawer tabs / closing and
 * reopening the drawer.
 */
export default function AgentAssets({ bridgeUrl, character }) {
  const pubkey = character?.pubkey

  const state = useSyncExternalStore(
    (cb) => tposeStore.subscribe(pubkey, cb),
    () => tposeStore.getState(pubkey),
    () => tposeStore.getState(pubkey),
  )

  const [tposeImgUrl, setTposeImgUrl] = useState(
    pubkey ? `${bridgeUrl}/characters/${pubkey}/tpose?t=${character?.updatedAt ?? 0}` : null
  )
  const [hasTpose, setHasTpose] = useState(true)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!state.loading) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.loading])

  useEffect(() => {
    if (state.tposeUrl) {
      setTposeImgUrl(state.tposeUrl)
      setHasTpose(true)
    }
  }, [state.tposeUrl])

  function generate() { tposeStore.start({ pubkey, bridgeUrl }) }
  function cancel() { tposeStore.cancel(pubkey) }

  const elapsedMs = computeElapsed(state, now)
  const elapsedLabel = formatElapsed(elapsedMs)
  const stageLabel = renderStageLabel(state.stage, state.stageMessage, state.etaSeconds, elapsedLabel)
  const progressPct = computeProgress(state, elapsedMs)
  const hasResult = !!(tposeImgUrl && hasTpose)

  return (
    <div className="agent-assets">
      {/* T-pose section ─────────────────────────────── */}
      <section className="agent-assets-section">
        <header className="agent-assets-section-head">
          <span className="agent-assets-step">01</span>
          <h4>T-pose</h4>
          <span className={`agent-assets-status ${state.loading ? 'is-loading' : hasResult ? 'is-ready' : 'is-empty'}`}>
            {state.loading ? 'working' : hasResult ? 'ready' : 'idle'}
          </span>
        </header>
        <p className="agent-assets-desc">
          Full-body reference generated from the avatar via self-hosted FLUX.1-Kontext.
        </p>

        <div className="agent-assets-pipeline">
          <Tile label="avatar" caption="source">
            {character?.avatarUrl ? (
              <img src={character.avatarUrl} alt="avatar" />
            ) : (
              <span className="agent-assets-tile-empty">no avatar</span>
            )}
          </Tile>

          <Arrow />

          <Tile label="t-pose" caption="result">
            {state.loading && state.stage !== 'done' ? (
              <div className="agent-assets-progress">
                <div className="agent-assets-progress-bar">
                  <div className="agent-assets-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                <div className="agent-assets-progress-label">{stageLabel}</div>
              </div>
            ) : hasResult ? (
              <img src={tposeImgUrl} alt="t-pose" onError={() => setHasTpose(false)} />
            ) : (
              <span className="agent-assets-tile-empty">none yet</span>
            )}
          </Tile>
        </div>

        <div className="agent-assets-actions">
          {state.loading ? (
            <button type="button" onClick={cancel} className="agent-assets-btn">
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={generate}
              disabled={!character?.avatarUrl}
              className="agent-assets-btn primary"
            >
              {hasResult ? 'Regenerate' : 'Generate'}
            </button>
          )}
          {!character?.avatarUrl && !state.loading && (
            <span className="agent-assets-hint">generate an avatar first</span>
          )}
        </div>

        {state.error && <p className="agent-profile-error">{state.error}</p>}
      </section>

      {/* 3D Model placeholder ───────────────────────── */}
      <section className="agent-assets-section is-locked">
        <header className="agent-assets-section-head">
          <span className="agent-assets-step">02</span>
          <h4>3D Model</h4>
          <span className="agent-assets-status is-soon">soon</span>
        </header>
        <p className="agent-assets-desc">
          Rigged 3D model auto-built from the T-pose. Viewable in-browser, plays animations
          (idle, walk, wave, etc.).
        </p>

        <div className="agent-assets-pipeline">
          <Tile label="t-pose" caption="source" muted>
            {hasResult ? (
              <img src={tposeImgUrl} alt="t-pose" />
            ) : (
              <span className="agent-assets-tile-empty">awaiting t-pose</span>
            )}
          </Tile>

          <Arrow muted />

          <Tile label="3d model" caption="result" muted>
            <div className="agent-assets-soon">
              <CubeIcon />
              <span>coming soon</span>
            </div>
          </Tile>
        </div>

        <div className="agent-assets-actions">
          <button type="button" disabled className="agent-assets-btn">
            Build model
          </button>
          <span className="agent-assets-hint">not yet implemented</span>
        </div>
      </section>
    </div>
  )
}

function Tile({ label, caption, muted, children }) {
  return (
    <figure className={`agent-assets-tile${muted ? ' is-muted' : ''}`}>
      <div className="agent-assets-tile-frame">{children}</div>
      <figcaption>
        <span className="agent-assets-tile-label">{label}</span>
        <span className="agent-assets-tile-caption">{caption}</span>
      </figcaption>
    </figure>
  )
}

function Arrow({ muted }) {
  return (
    <div className={`agent-assets-arrow${muted ? ' is-muted' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 12h15M13 6l6 6-6 6" />
      </svg>
    </div>
  )
}

function CubeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  )
}

function computeElapsed(state, now) {
  if (!state.startedAt) return state.heartbeatElapsedMs || 0
  const local = now - state.startedAt
  return Math.max(local, state.heartbeatElapsedMs || 0)
}

function computeProgress(state, elapsedMs) {
  // Indeterminate-feeling but bounded fill so the bar always moves
  // forward. We never reach 100 until 'done' lands.
  if (state.stage === 'done') return 100
  if (!state.etaSeconds) return Math.min(85, (elapsedMs / 60000) * 100)
  const fraction = elapsedMs / (state.etaSeconds * 1000)
  return Math.min(95, Math.max(3, fraction * 100))
}

function formatElapsed(ms) {
  if (!ms) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function renderStageLabel(stage, message, etaSeconds, elapsed) {
  if (!stage) return ''
  if (stage === 'probing') return 'checking service…'
  if (stage === 'warm') return `warm · generating (~${etaSeconds ?? 15}s)`
  if (stage === 'cold-start') {
    const eta = etaSeconds ? ` / ~${formatElapsed(etaSeconds * 1000)}` : ''
    return `cold start · ${elapsed}${eta}`
  }
  if (stage === 'generating') {
    const eta = etaSeconds ? ` / ~${formatElapsed(etaSeconds * 1000)}` : ''
    return `generating · ${elapsed}${eta}`
  }
  if (stage === 'done') return 'done'
  if (stage === 'error') return 'failed'
  return message || ''
}

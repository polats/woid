import { useEffect, useState, useSyncExternalStore } from 'react'
import * as tposeStore from './lib/tposeStore.js'
import * as modelStore from './lib/modelStore.js'
import GlbViewer from './GlbViewer.jsx'
import Lightbox from './components/Lightbox.jsx'

/**
 * Assets tab — derivative imagery and rigs for a character.
 *
 * Pipeline:
 *   01 T-pose      (FLUX.1-Kontext) ─ avatar → t-pose reference
 *   02 3D Model    (TRELLIS)        ─ t-pose → GLB, viewable in-browser
 *   03 Animations  (placeholder)    ─ to come (Kimodo-Motion)
 *
 * Each stage's job runs in a module-scoped store (lib/tposeStore,
 * lib/modelStore) so an in-flight generation survives drawer-tab
 * switches and remounts.
 */
export default function AgentAssets({ bridgeUrl, character }) {
  const pubkey = character?.pubkey
  // Shared lightbox state — click any image in any section to open.
  const [lightbox, setLightbox] = useState(null)  // { src, alt } | null

  return (
    <div className="agent-assets">
      <TposeSection bridgeUrl={bridgeUrl} character={character} onView={setLightbox} />
      <ModelSection bridgeUrl={bridgeUrl} pubkey={pubkey} onView={setLightbox} />
      <AnimationsPlaceholder />
      <Lightbox
        src={lightbox?.src}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
    </div>
  )
}

/* ── Section 01: T-pose ───────────────────────────────────────── */

function TposeSection({ bridgeUrl, character, onView }) {
  const pubkey = character?.pubkey
  const state = useStoreState(tposeStore, pubkey)
  const initialUrl = pubkey ? `${bridgeUrl}/characters/${pubkey}/tpose?t=${character?.updatedAt ?? 0}` : null

  const [imgUrl, setImgUrl] = useState(initialUrl)
  const [hasResult, setHasResult] = useState(true) // <img> onError flips it
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!state.loading) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.loading])

  useEffect(() => {
    if (state.resultUrl) {
      setImgUrl(state.resultUrl)
      setHasResult(true)
    }
  }, [state.resultUrl])

  const elapsedMs = computeElapsed(state, now)
  const elapsedLabel = formatElapsed(elapsedMs)
  const stageLabel = renderStageLabel(state, elapsedLabel)
  const progressPct = computeProgress(state, elapsedMs)
  const ready = !!(imgUrl && hasResult)

  return (
    <section className="agent-assets-section">
      <SectionHead step="01" title="T-pose" status={state.loading ? 'is-loading' : ready ? 'is-ready' : 'is-empty'} statusLabel={state.loading ? 'working' : ready ? 'ready' : 'idle'} />
      <p className="agent-assets-desc">
        Full-body reference generated from the avatar via self-hosted FLUX.1-Kontext.
      </p>

      <div className="agent-assets-pipeline">
        <Tile label="avatar" caption="source">
          {character?.avatarUrl
            ? <img
                src={character.avatarUrl}
                alt="avatar"
                className="is-clickable"
                onClick={() => onView?.({ src: character.avatarUrl, alt: 'avatar' })}
              />
            : <Empty>no avatar</Empty>}
        </Tile>
        <Arrow />
        <Tile label="t-pose" caption="result">
          {state.loading && state.stage !== 'done' ? (
            <Progress pct={progressPct} label={stageLabel} />
          ) : ready ? (
            <img
              src={imgUrl}
              alt="t-pose"
              className="is-clickable"
              onClick={() => onView?.({ src: imgUrl, alt: 't-pose' })}
              onError={() => setHasResult(false)}
            />
          ) : (
            <Empty>none yet</Empty>
          )}
        </Tile>
      </div>

      <ActionRow
        loading={state.loading}
        onCancel={() => tposeStore.cancel(pubkey)}
        onRun={() => tposeStore.start({ pubkey, bridgeUrl })}
        canRun={!!character?.avatarUrl}
        runLabel={ready ? 'Regenerate' : 'Generate'}
        hint={!character?.avatarUrl ? 'generate an avatar first' : null}
        error={state.error}
      />
    </section>
  )
}

/* ── Section 02: 3D Model ─────────────────────────────────────── */

function ModelSection({ bridgeUrl, pubkey, onView }) {
  const state = useStoreState(modelStore, pubkey)
  const initialUrl = pubkey ? `${bridgeUrl}/characters/${pubkey}/model?t=0` : null

  const [modelUrl, setModelUrl] = useState(initialUrl)
  const [hasModel, setHasModel] = useState(false)
  const [tposeReady, setTposeReady] = useState(false)
  const [now, setNow] = useState(Date.now())

  // Probe: does this character have a saved GLB? Avoids the GlbViewer
  // attempting to load a 404 on first mount.
  useEffect(() => {
    if (!pubkey || !bridgeUrl) return
    let cancelled = false
    fetch(`${bridgeUrl}/characters/${pubkey}/model`, { method: 'HEAD' })
      .then((r) => { if (!cancelled) setHasModel(r.ok) })
      .catch(() => { if (!cancelled) setHasModel(false) })
    fetch(`${bridgeUrl}/characters/${pubkey}/tpose`, { method: 'HEAD' })
      .then((r) => { if (!cancelled) setTposeReady(r.ok) })
      .catch(() => { if (!cancelled) setTposeReady(false) })
    return () => { cancelled = true }
  }, [bridgeUrl, pubkey])

  useEffect(() => {
    if (!state.loading) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [state.loading])

  useEffect(() => {
    if (state.resultUrl) {
      setModelUrl(state.resultUrl)
      setHasModel(true)
    }
  }, [state.resultUrl])

  // When the t-pose store finishes, the next-stage button should unlock.
  const tposeState = useStoreState(tposeStore, pubkey)
  useEffect(() => {
    if (tposeState.resultUrl) setTposeReady(true)
  }, [tposeState.resultUrl])

  const elapsedMs = computeElapsed(state, now)
  const elapsedLabel = formatElapsed(elapsedMs)
  const stageLabel = renderStageLabel(state, elapsedLabel)
  const progressPct = computeProgress(state, elapsedMs)
  const ready = hasModel && !!modelUrl

  return (
    <section className={`agent-assets-section${tposeReady ? '' : ' is-locked'}`}>
      <SectionHead
        step="02"
        title="3D Model"
        status={state.loading ? 'is-loading' : ready ? 'is-ready' : 'is-empty'}
        statusLabel={state.loading ? 'working' : ready ? 'ready' : 'idle'}
      />
      <p className="agent-assets-desc">
        Image-to-3D via two self-hosted backends:{' '}
        <strong>TRELLIS</strong> (cleaner topology, faster) or{' '}
        <strong>Hunyuan3D-2</strong> (richer textures). Output is a GLB you can orbit.
      </p>

      <div className="agent-assets-pipeline">
        <Tile label="t-pose" caption="source" muted={!tposeReady}>
          {tposeReady ? (
            <img
              src={`${bridgeUrl}/characters/${pubkey}/tpose`}
              alt="t-pose"
              className="is-clickable"
              onClick={() => onView?.({ src: `${bridgeUrl}/characters/${pubkey}/tpose`, alt: 't-pose' })}
            />
          ) : (
            <Empty>awaiting t-pose</Empty>
          )}
        </Tile>
        <Arrow muted={!tposeReady} />
        <Tile label="3d model" caption="result" muted={!ready && !state.loading} frameTall>
          {state.loading && state.stage !== 'done' ? (
            <Progress pct={progressPct} label={stageLabel} />
          ) : ready ? (
            <GlbViewer src={modelUrl} />
          ) : (
            <Empty>none yet</Empty>
          )}
        </Tile>
      </div>

      {/* Two action buttons, one per backend. While loading, both
          collapse to a single Cancel + a "<backend> in progress…" hint
          driven by state.meta which we stash on start(). */}
      <div className="agent-assets-actions">
        {state.loading ? (
          <>
            <button
              type="button"
              onClick={() => modelStore.cancel(pubkey)}
              className="agent-assets-btn"
            >
              Cancel
            </button>
            <span className="agent-assets-hint">
              {state.meta?.backend
                ? `${state.meta.backend} in progress · ${stageLabel}`
                : stageLabel}
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => modelStore.start({
                pubkey, bridgeUrl,
                body: { backend: 'trellis' },
                meta: { backend: 'trellis' },
              })}
              disabled={!tposeReady}
              className="agent-assets-btn primary"
              title="TRELLIS — clean topology, ~25s warm"
            >
              {ready ? 'Regenerate (TRELLIS)' : 'Generate (TRELLIS)'}
            </button>
            <button
              type="button"
              onClick={() => modelStore.start({
                pubkey, bridgeUrl,
                body: { backend: 'hunyuan3d' },
                meta: { backend: 'hunyuan3d' },
              })}
              disabled={!tposeReady}
              className="agent-assets-btn"
              title="Hunyuan3D-2 — richer textures, ~70s warm"
            >
              {ready ? 'Regenerate (Hunyuan3D)' : 'Generate (Hunyuan3D)'}
            </button>
            {!tposeReady && (
              <span className="agent-assets-hint">generate a t-pose first</span>
            )}
          </>
        )}
      </div>
      {state.error && <p className="agent-profile-error">{state.error}</p>}
    </section>
  )
}

/* ── Section 03: Animations placeholder ───────────────────────── */

function AnimationsPlaceholder() {
  return (
    <section className="agent-assets-section is-locked">
      <SectionHead step="03" title="Animations" status="is-soon" statusLabel="soon" />
      <p className="agent-assets-desc">
        Rigged motion clips (idle, walk, wave, dance) generated from text via Kimodo-Motion,
        retargeted onto the GLB rig.
      </p>
      <div className="agent-assets-pipeline">
        <Tile label="model" caption="source" muted>
          <Empty>awaiting model</Empty>
        </Tile>
        <Arrow muted />
        <Tile label="animated" caption="result" muted>
          <div className="agent-assets-soon">
            <PlayIcon />
            <span>coming soon</span>
          </div>
        </Tile>
      </div>
      <div className="agent-assets-actions">
        <button type="button" disabled className="agent-assets-btn">Animate</button>
        <span className="agent-assets-hint">not yet implemented</span>
      </div>
    </section>
  )
}

/* ── Shared bits ──────────────────────────────────────────────── */

function useStoreState(store, pubkey) {
  return useSyncExternalStore(
    (cb) => store.subscribe(pubkey, cb),
    () => store.getState(pubkey),
    () => store.getState(pubkey),
  )
}

function SectionHead({ step, title, status, statusLabel }) {
  return (
    <header className="agent-assets-section-head">
      <span className="agent-assets-step">{step}</span>
      <h4>{title}</h4>
      <span className={`agent-assets-status ${status}`}>{statusLabel}</span>
    </header>
  )
}

function Tile({ label, caption, muted, frameTall, children }) {
  return (
    <figure className={`agent-assets-tile${muted ? ' is-muted' : ''}${frameTall ? ' is-tall' : ''}`}>
      <div className="agent-assets-tile-frame">{children}</div>
      <figcaption>
        <span className="agent-assets-tile-label">{label}</span>
        <span className="agent-assets-tile-caption">{caption}</span>
      </figcaption>
    </figure>
  )
}

function Empty({ children }) {
  return <span className="agent-assets-tile-empty">{children}</span>
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

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l6 3.5-6 3.5z" fill="currentColor" />
    </svg>
  )
}

function Progress({ pct, label }) {
  return (
    <div className="agent-assets-progress">
      <div className="agent-assets-progress-bar">
        <div className="agent-assets-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="agent-assets-progress-label">{label}</div>
    </div>
  )
}

function ActionRow({ loading, onCancel, onRun, canRun, runLabel, hint, error }) {
  return (
    <>
      <div className="agent-assets-actions">
        {loading ? (
          <button type="button" onClick={onCancel} className="agent-assets-btn">Cancel</button>
        ) : (
          <button type="button" onClick={onRun} disabled={!canRun} className="agent-assets-btn primary">
            {runLabel}
          </button>
        )}
        {hint && !loading && <span className="agent-assets-hint">{hint}</span>}
      </div>
      {error && <p className="agent-profile-error">{error}</p>}
    </>
  )
}

/* ── Helpers ──────────────────────────────────────────────────── */

function computeElapsed(state, now) {
  if (!state.startedAt) return state.heartbeatElapsedMs || 0
  const local = now - state.startedAt
  return Math.max(local, state.heartbeatElapsedMs || 0)
}

function computeProgress(state, elapsedMs) {
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

function renderStageLabel(state, elapsed) {
  const { stage, stageMessage, etaSeconds } = state
  if (!stage) return ''
  if (stage === 'probing') return 'checking service…'
  if (stage === 'warm') return `warm · generating (~${etaSeconds ?? 30}s)`
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
  return stageMessage || ''
}

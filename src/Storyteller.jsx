import { useEffect, useState } from 'react'
import config from './config.js'

const cfg = config.agentSandbox || {}

/**
 * Storyteller — observe and steer the director.
 *
 * Five sections, in order of how often you'll look at them:
 *   1. Director — what it is, current intensity + target.
 *   2. This tick — phase, in-room, queue, manual controls.
 *   3. Fire log — every card the director has fired (persists across reload).
 *   4. Card pool — every card with eligibility + why it's blocked.
 *   5. Glossary — short reminder of what each control does.
 */
export default function Storyteller({ characters = [], onInspect } = {}) {
  const nameByPubkey = new Map(characters.map((c) => [c.pubkey, c.name || c.pubkey.slice(0, 8)]))
  const [snap, setSnap] = useState(null)
  const [log, setLog] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [openSection, setOpenSection] = useState({
    director: true, tick: true, log: true, pool: true, glossary: false,
  })

  useEffect(() => {
    if (!cfg.bridgeUrl) return
    let cancelled = false
    async function load() {
      try {
        const [s, l] = await Promise.all([
          fetch(`${cfg.bridgeUrl}/storyteller/snapshot`).then((r) => r.json()),
          fetch(`${cfg.bridgeUrl}/storyteller/log?limit=50`).then((r) => r.json()),
        ])
        if (cancelled) return
        setSnap(s)
        setLog(l.entries || [])
        setError(null)
      } catch (err) {
        if (!cancelled) setError(err.message || String(err))
      }
    }
    load()
    const t = setInterval(load, 4000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  async function tickNow() {
    setBusy('tick')
    try {
      const r = await fetch(`${cfg.bridgeUrl}/storyteller/tick`, { method: 'POST' }).then((r) => r.json())
      if (r.error) setError(r.error)
      await refreshLog()
    } catch (err) { setError(err.message || String(err)) }
    finally { setBusy(null) }
  }

  async function fireCard(cardId) {
    setBusy(`fire:${cardId}`)
    try {
      const r = await fetch(`${cfg.bridgeUrl}/storyteller/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: cardId }),
      }).then((r) => r.json())
      if (r.error) setError(r.error)
      await refreshLog()
    } catch (err) { setError(err.message || String(err)) }
    finally { setBusy(null) }
  }

  async function resetSession() {
    setBusy('reset')
    try {
      await fetch(`${cfg.bridgeUrl}/storyteller/reset-session`, { method: 'POST' })
    } catch (err) { setError(err.message || String(err)) }
    finally { setBusy(null) }
  }

  async function refreshLog() {
    try {
      const l = await fetch(`${cfg.bridgeUrl}/storyteller/log?limit=50`).then((r) => r.json())
      setLog(l.entries || [])
    } catch { /* ignore */ }
  }

  if (error && !snap) return <div className="st-error">{error}</div>
  if (!snap) return <div className="st-loading muted">Loading storyteller…</div>

  const intensityPct = Math.round(snap.intensity * 100)
  const targetPct = Math.round(snap.target * 100)
  const direction = snap.target > snap.intensity ? 'rising' : snap.target < snap.intensity ? 'falling' : 'steady'
  const noChars = snap.character_count === 0

  const byPhase = {}
  for (const c of snap.cards || []) {
    if (!byPhase[c.phase]) byPhase[c.phase] = []
    byPhase[c.phase].push(c)
  }
  const phaseOrder = ['cold_open', 'opening', 'ambient', 'closing', 'cliffhanger']
  const phases = phaseOrder.filter((p) => byPhase[p])

  return (
    <div className="storyteller">
      {error && <div className="st-error-banner">{error}</div>}

      {/* ── Director — intensity gauge + explainer ─────────────────── */}
      <Section title="Director" subtitle="Picks moments. Doesn't write the scenes."
        open={openSection.director} onToggle={() => setOpenSection((s) => ({ ...s, director: !s.director }))}>
        <p className="st-blurb">
          Tracks one scalar — <strong>intensity</strong> — that drifts toward a target derived from how many
          characters are in a lousy mood. Rises in ~25 sim-min, falls in ~400. Each tick it picks one card
          whose phase, intensity window, and cooldown all pass.
        </p>
        <div className="st-gauge">
          <div className="st-gauge-row">
            <span className="st-gauge-label">intensity</span>
            <strong className="st-gauge-val">{intensityPct}</strong>
            <span className="muted">→ target {targetPct} ({direction})</span>
          </div>
          <div className="st-gauge-track">
            <div className="st-gauge-fill" style={{ width: `${intensityPct}%` }}
              title={`current: ${snap.intensity.toFixed(3)}`} />
            <div className="st-gauge-target" style={{ left: `${targetPct}%` }}
              title={`target: ${snap.target.toFixed(3)}`} />
          </div>
          <div className="st-gauge-axis">
            <span>0 quiet</span>
            <span>0.5</span>
            <span>1.0 hot</span>
          </div>
        </div>
      </Section>

      {/* ── This tick — current frame + controls ──────────────────── */}
      <Section title="This tick" subtitle="What the director sees right now."
        open={openSection.tick} onToggle={() => setOpenSection((s) => ({ ...s, tick: !s.tick }))}>
        <dl className="st-meta">
          <Stat label="phase" value={snap.current_phase} hint={`derived from sim-clock slot "${snap.current_slot || '—'}"`} />
          <Stat label="in-room" value={snap.character_count} hint="characters with a live runtime — only these can be bound to card roles" />
          <Stat label="queue" value={snap.queue_depth} hint="cards scheduled by TriggerCard, waiting to fire" />
        </dl>
        <div className="st-controls">
          <button type="button" onClick={tickNow} disabled={!!busy || noChars}>
            {busy === 'tick' ? 'ticking…' : 'Tick now'}
          </button>
          <button type="button" onClick={resetSession} disabled={!!busy}>
            {busy === 'reset' ? 'resetting…' : 'Reset session memory'}
          </button>
          {noChars && <span className="st-hint">Drop a character into the room — the director needs roles to bind.</span>}
        </div>
      </Section>

      {/* ── Fire log — persistent history ─────────────────────────── */}
      <Section title={`Fire log (${log.length})`} subtitle="Every card the director has decided to fire — manual, scheduled, or auto-tick."
        open={openSection.log} onToggle={() => setOpenSection((s) => ({ ...s, log: !s.log }))}>
        {log.length === 0 ? (
          <p className="muted st-empty">No fires yet. Drop a character in and either wait for the auto-tick or click Fire on a card below.</p>
        ) : (
          <ol className="st-log">
            {log.map((rec, i) => (
              <FireLogRow key={`${rec.fired_at}-${i}`} rec={rec} nameByPubkey={nameByPubkey} onInspect={onInspect} />
            ))}
          </ol>
        )}
      </Section>

      {/* ── Card pool — eligibility breakdown ──────────────────────── */}
      <Section title={`Card pool (${snap.cards?.length || 0})`} subtitle="Each card's window, weight, and why it's eligible — or not."
        open={openSection.pool} onToggle={() => setOpenSection((s) => ({ ...s, pool: !s.pool }))}>
        {snap.load_errors?.length > 0 && (
          <div className="st-load-errors">
            <strong>{snap.load_errors.length} load error{snap.load_errors.length === 1 ? '' : 's'}:</strong>
            <ul>{snap.load_errors.map((e, i) => <li key={i}><code>{e.path}</code>: {e.error}</li>)}</ul>
          </div>
        )}
        {phases.map((phase) => (
          <div key={phase} className="st-phase-group">
            <h4 className="st-phase-head">
              {phase}
              {snap.current_phase === phase && <span className="st-phase-now">current</span>}
              <span className="muted st-phase-count">({byPhase[phase].length})</span>
            </h4>
            <ul className="st-cards">
              {byPhase[phase].map((c) => (
                <CardRow key={c.id} card={c} onFire={fireCard} busy={busy} disabled={noChars} />
              ))}
            </ul>
          </div>
        ))}
      </Section>

      {/* ── Glossary — what the controls do ────────────────────────── */}
      <Section title="Glossary"
        open={openSection.glossary} onToggle={() => setOpenSection((s) => ({ ...s, glossary: !s.glossary }))}>
        <dl className="st-glossary">
          <dt>Tick now</dt>
          <dd>Forces an immediate director tick: lerp intensity, drain scheduled queue, attempt to fire one eligible card. Skips the wait for the next 60s auto-tick.</dd>
          <dt>Reset session memory</dt>
          <dd>Clears <code>firedThisSession</code> so once-per-session cards (morning-kettle, journal-thought) can fire again without waiting for sim-day rollover. Doesn't touch cooldowns or intensity.</dd>
          <dt>Fire (per card)</dt>
          <dd>Fires the card immediately, ignoring eligibility (phase, intensity, cooldown). Useful for verifying a card's effects without waiting.</dd>
          <dt>Phase</dt>
          <dd>Sim-clock slot maps to phase: morning → opening, evening/night → closing, otherwise ambient. Only same-phase cards are auto-fire candidates.</dd>
          <dt>Intensity window</dt>
          <dd>Each card has <code>[intensity_min, intensity_max]</code>. Cards only fire when the director's current intensity sits inside their window.</dd>
          <dt>Weight</dt>
          <dd>Among eligible cards, selection is weighted-random by <code>weight</code>. Higher = picked more often.</dd>
          <dt>Cooldown</dt>
          <dd><code>cooldown_sim_min</code> after a fire, the same card is locked out — even if everything else passes.</dd>
        </dl>
      </Section>
    </div>
  )
}

function Section({ title, subtitle, open, onToggle, children }) {
  return (
    <section className={`st-section${open ? ' open' : ''}`}>
      <button type="button" className="st-section-head" onClick={onToggle} aria-expanded={open}>
        <span className="st-section-caret">{open ? '▼' : '▶'}</span>
        <span className="st-section-title">{title}</span>
        {subtitle && <span className="st-section-subtitle muted">{subtitle}</span>}
      </button>
      {open && <div className="st-section-body">{children}</div>}
    </section>
  )
}

function Stat({ label, value, hint }) {
  return (
    <div className="st-stat" title={hint}>
      <span className="st-stat-label">{label}</span>
      <strong className="st-stat-value">{value}</strong>
    </div>
  )
}

function FireLogRow({ rec, nameByPubkey, onInspect }) {
  const bindings = rec.bindings && Object.entries(rec.bindings)
  const time = new Date(rec.fired_at).toLocaleTimeString()
  const sourceLabel = { manual: 'manual', tick: 'auto', scheduled: 'scheduled' }[rec.source] || rec.source
  return (
    <li className={`st-log-row st-log-${rec.ok ? 'ok' : 'fail'}`}>
      <div className="st-log-head">
        <span className="muted st-log-time">{time}</span>
        <code className="st-log-card">{rec.card_id}</code>
        <span className={`st-log-source st-log-source-${rec.source}`}>{sourceLabel}</span>
        <span className="muted st-log-meta">phase {rec.phase} · int {rec.intensity?.toFixed?.(2) ?? rec.intensity}</span>
      </div>
      {bindings && bindings.length > 0 && (
        <div className="st-log-bindings">
          {bindings.map(([role, pubkey]) => (
            <span key={role} className="st-log-binding">
              <span className="muted">{role}</span>{' '}
              {onInspect ? (
                <button type="button" className="st-link"
                  onClick={() => onInspect(pubkey)}
                  title="Open in inspector">
                  {nameByPubkey.get(pubkey) || pubkey.slice(0, 8)}
                </button>
              ) : (
                <span>{nameByPubkey.get(pubkey) || pubkey.slice(0, 8)}</span>
              )}
            </span>
          ))}
        </div>
      )}
      {!rec.ok && rec.reason && <div className="st-log-reason">{rec.reason}</div>}
    </li>
  )
}

function CardRow({ card, onFire, busy, disabled }) {
  return (
    <li className={`st-card${card.eligible_now ? ' eligible' : ''}`}>
      <div className="st-card-head">
        <strong className="st-card-id">{card.id}</strong>
        {card.eligible_now ? (
          <span className="st-badge st-badge-ok">eligible</span>
        ) : card.blocked_by ? (
          <span className={`st-badge st-badge-${card.blocked_by.kind}`} title={card.blocked_by.message}>
            {card.blocked_by.kind.replace(/_/g, ' ')}
          </span>
        ) : null}
        <span className="st-card-window muted">
          int [{card.intensity_min.toFixed(2)}–{card.intensity_max.toFixed(2)}] · w{card.weight}
          {card.cooldown_sim_min > 0 && ` · cd ${card.cooldown_sim_min}m`}
          {card.once_per_session && ' · once'}
        </span>
        <button type="button" className="st-fire-btn"
          onClick={() => onFire(card.id)}
          disabled={busy === `fire:${card.id}` || disabled}
          title="Fire this card immediately, ignoring eligibility">
          {busy === `fire:${card.id}` ? '…' : 'Fire'}
        </button>
      </div>
      {card.description && <p className="st-card-desc muted">{card.description}</p>}
      {card.blocked_by && <p className="st-card-blocked muted">— {card.blocked_by.message}</p>}
    </li>
  )
}

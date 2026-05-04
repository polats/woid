import { useCallback, useEffect, useRef, useState } from 'react'
import config from '../config.js'

/**
 * Dashboard for one external service. Used by /services/:name routes.
 *
 * Renders four sections:
 *   1. Header with description.
 *   2. Top stats: state badge, in-flight count, warm-age, total wakes.
 *   3. Wake control — POSTs /v1/services/:name/wake (SSE), shows
 *      cold-start progress live.
 *   4. (Stub for now) Recent call log — once we wire the per-service
 *      log on the backend (`service-log.js`), this fills in.
 *
 * Generic — takes the service name as a prop. No per-service code.
 */
export default function ApiStatusPage({ service }) {
  const bridgeUrl = config.agentSandbox?.bridgeUrl
  const [snap, setSnap] = useState(null)
  const [err, setErr] = useState(null)
  const [waking, setWaking] = useState(false)
  const [wakeStage, setWakeStage] = useState(null)
  const [wakeStart, setWakeStart] = useState(null)
  const [now, setNow] = useState(Date.now())
  const wakeAbortRef = useRef(null)

  // Reset all per-service state when the URL switches between
  // services. Without this, navigating /services/trellis →
  // /services/flux-kontext keeps the prior service's snap+wakeStage
  // visible until the next poll lands.
  useEffect(() => {
    wakeAbortRef.current?.abort()
    wakeAbortRef.current = null
    setSnap(null)
    setErr(null)
    setWaking(false)
    setWakeStage(null)
    setWakeStart(null)
  }, [service])

  // Snapshot poller — refreshes every 5s when not waking, every 1s while waking.
  const refresh = useCallback(async () => {
    if (!bridgeUrl) return
    try {
      const r = await fetch(`${bridgeUrl}/v1/services/${service}/status`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setSnap(data)
      setErr(null)
    } catch (e) {
      setErr(e.message || String(e))
    }
  }, [bridgeUrl, service])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, waking ? 1000 : 5000)
    return () => clearInterval(id)
  }, [refresh, waking])

  // Local 1s ticker — drives all "live" values on the page (warm-for,
  // warming-for, sleeps-in countdown, in-flight elapsed). Tick faster
  // (250ms) while a wake is in progress so the cold-start counter
  // feels alive.
  useEffect(() => {
    const interval = waking ? 250 : 1000
    const id = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(id)
  }, [waking])

  async function wake() {
    if (!bridgeUrl || waking) return
    setWaking(true)
    setWakeStage({ stage: 'starting', message: 'opening wake stream…' })
    setWakeStart(Date.now())
    const ctrl = new AbortController()
    wakeAbortRef.current = ctrl
    try {
      const res = await fetch(`${bridgeUrl}/v1/services/${service}/wake`, {
        method: 'POST',
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const events = buf.split(/\n\n/)
        buf = events.pop() ?? ''
        for (const evChunk of events) {
          const lines = evChunk.split('\n')
          let evType = 'message'
          const dataLines = []
          for (const line of lines) {
            if (line.startsWith('event:')) evType = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          const data = dataLines.join('\n')
          if (!data) continue
          let parsed
          try { parsed = JSON.parse(data) } catch { continue }
          if (evType === 'stage') setWakeStage(parsed)
          else if (evType === 'heartbeat') setWakeStage((s) => ({ ...s, elapsedMs: parsed.elapsedMs }))
          else if (evType === 'done') setWakeStage({ stage: 'done', ...parsed })
          else if (evType === 'error') throw new Error(parsed.error || 'wake error')
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setWakeStage({ stage: 'error', message: e.message || String(e) })
      }
    } finally {
      setWaking(false)
      wakeAbortRef.current = null
      // Final snapshot to update the visible state immediately.
      refresh()
    }
  }

  function cancelWake() {
    wakeAbortRef.current?.abort()
  }

  if (!bridgeUrl) return <p style={{ padding: 32 }}>Bridge URL not configured.</p>
  if (err && !snap) return <p style={{ padding: 32, color: 'crimson' }}>Failed to load: {err}</p>
  if (!snap) return <p style={{ padding: 32 }}>Loading…</p>

  const wakeElapsed = wakeStart ? Math.max(0, now - wakeStart) : 0
  const stageLabel = renderStage(wakeStage, wakeElapsed)

  // Live-tick'd derived numbers. Snapshot supplies anchor timestamps;
  // the local 1s ticker re-renders these every second.
  const warmForMs = snap.status === 'warm' && snap.lastWarm
    ? now - snap.lastWarm : null
  const warmingForMs = snap.status === 'warming' && snap.warmingStartedAt
    ? now - snap.warmingStartedAt : null
  const sleepInMs = snap.idleTimeoutMs && snap.status === 'warm' && snap.inFlight === 0
    ? Math.max(0, snap.idleTimeoutMs - (snap.lastActivityAt
        ? now - snap.lastActivityAt
        : 0))
    : null
  const lastColdAgo = snap.lastBecameWarmAt ? now - snap.lastBecameWarmAt : null

  return (
    <div className="api-status-page" style={pageStyle}>
      {/* ── HERO ──────────────────────────────────────── */}
      <div className="api-status-hero" style={heroStyle(snap.status)}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={heroEyebrow}>{snap.kind} · {snap.name}</div>
          <h1 style={heroTitle}>{snap.label || service}</h1>
          <p style={heroDesc}>{snap.description}</p>
        </div>
        <div style={heroAction}>
          <StateBadge status={snap.status} large />
          {!waking ? (
            <button
              type="button"
              onClick={wake}
              className="agent-assets-btn primary"
              disabled={!snap.configured}
              style={{ marginTop: 12 }}
              title={snap.configured ? `Wake ${snap.label}` : `${snap.kind} not configured`}
            >
              {snap.status === 'warm' ? 'Re-probe' : 'Wake service'}
            </button>
          ) : (
            <button type="button" onClick={cancelWake} className="agent-assets-btn"
              style={{ marginTop: 12 }}>
              Cancel wake
            </button>
          )}
        </div>
      </div>

      {waking && (
        <div style={progressBanner}>
          <div style={progressBarTrack}>
            <div style={{ ...progressBarFill, width: `${progressPctFromStage(wakeStage, wakeElapsed, snap.coldEtaSeconds)}%` }} />
          </div>
          <div style={progressLabel}>{stageLabel}</div>
        </div>
      )}

      {!snap.configured && (
        <div style={errorBanner}>
          {snap.name === 'unirig'
            ? 'UniRig URL not set — start the local Docker container.'
            : `Env var for ${snap.label} not set in the bridge.`}
        </div>
      )}

      {snap.lastError && (
        <div style={errorBanner}>last error: {snap.lastError}</div>
      )}

      {/* ── LIFE METRICS ──────────────────────────────── */}
      <div style={metricsGrid}>
        <Metric label="In flight" value={snap.inFlight ?? 0}
          tone={snap.inFlight > 0 ? 'active' : 'normal'} />
        {snap.status === 'warm' && warmForMs != null && (
          <Metric label="Warm for" value={formatDuration(warmForMs)}
            sublabel="since last successful probe" tone="ok" />
        )}
        {snap.status === 'warming' && warmingForMs != null && (
          <Metric label="Warming for" value={formatDuration(warmingForMs)}
            sublabel={`budget ${formatDuration(snap.coldBudgetMs)}`} tone="active" />
        )}
        {sleepInMs != null && (
          <Metric
            label="Sleeps in"
            value={snap.inFlight > 0 ? '— in use —' : formatDuration(sleepInMs)}
            sublabel={snap.idleTimeoutMs ? `idle timeout ${formatDuration(snap.idleTimeoutMs)}` : null}
            tone={snap.inFlight > 0 ? 'ok' : sleepInMs < 60_000 ? 'warn' : 'normal'}
          />
        )}
        <Metric label="Total wakes" value={snap.totalWakes ?? 0} />
      </div>

      {/* ── COLD-START LIFECYCLE ──────────────────────── */}
      {(snap.lastBecameWarmAt != null || snap.lastColdStartDurationMs != null) && (
        <Section title="Cold-start lifecycle">
          <div style={lifecycleRow}>
            {snap.lastBecameWarmAt != null && (
              <KeyVal k="Last cold start" v={`${formatRelative(lastColdAgo)} ago`} />
            )}
            {snap.lastColdStartDurationMs != null && (
              <KeyVal k="took" v={formatDuration(snap.lastColdStartDurationMs)} />
            )}
            {snap.lastColdStartedAt != null && (
              <KeyVal k="started at"
                v={new Date(snap.lastColdStartedAt).toLocaleTimeString()} />
            )}
            <KeyVal k="cold ETA" v={`${snap.coldEtaSeconds}s`} muted />
            <KeyVal k="warm ETA" v={`${snap.warmEtaSeconds}s`} muted />
          </div>
        </Section>
      )}

      {/* ── IN FLIGHT ─────────────────────────────────── */}
      <Section title={`In flight (${snap.inFlightCalls?.length ?? 0})`}>
        {snap.inFlightCalls && snap.inFlightCalls.length > 0 ? (
          <CallsCards calls={snap.inFlightCalls} now={now} live />
        ) : (
          <div style={emptyHint}>no calls in flight</div>
        )}
      </Section>

      {/* ── RECENT ────────────────────────────────────── */}
      <Section title={`Recent (${snap.recentCalls?.length ?? 0})`}>
        {snap.recentCalls && snap.recentCalls.length > 0 ? (
          <CallsTable calls={snap.recentCalls} now={now} live={false} />
        ) : (
          <div style={emptyHint}>no completed calls yet</div>
        )}
      </Section>

      {/* ── FOOTER METADATA ───────────────────────────── */}
      <div style={footerMeta}>
        url: <code>{snap.url || '—'}</code>
      </div>
    </div>
  )
}

/* ───── Layout primitives ───────────────────────────── */

function Section({ title, children }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={sectionH2}>{title}</h2>
      <div>{children}</div>
    </section>
  )
}

function Metric({ label, value, sublabel, tone = 'normal' }) {
  const toneStyles = {
    normal: { borderColor: 'var(--ink)', accent: 'var(--ink)' },
    ok:     { borderColor: 'var(--ink)', accent: 'var(--transmit-2, #2da14a)' },
    active: { borderColor: 'var(--violet, #6a4aa8)', accent: 'var(--violet, #6a4aa8)' },
    warn:   { borderColor: 'var(--transmit, #c83b3b)', accent: 'var(--transmit, #c83b3b)' },
  }
  const t = toneStyles[tone] || toneStyles.normal
  return (
    <div style={{
      border: `1.5px solid ${t.borderColor}`,
      background: 'var(--paper)',
      padding: '10px 14px',
      minWidth: 140,
      flex: '1 1 0',
    }}>
      <div style={metricLabel}>{label}</div>
      <div style={{ ...metricValue, color: t.accent }}>{value}</div>
      {sublabel && <div style={metricSubLabel}>{sublabel}</div>}
    </div>
  )
}

function KeyVal({ k, v, muted }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 110 }}>
      <span style={{ ...metricLabel, color: muted ? 'var(--ink-faint)' : 'var(--ink-2)' }}>{k}</span>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        color: muted ? 'var(--ink-faint)' : 'var(--ink)',
        marginTop: 2,
      }}>{v}</span>
    </div>
  )
}

function CallsCards({ calls, now, live }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
      {calls.map((c) => {
        const elapsedMs = live ? (now - c.startedAt) : c.durationMs
        return (
          <div key={c.callId} style={callCard}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <KindBadge kind={c.kind} />
              <strong style={{ fontFamily: 'var(--font-display)', fontStretch: '75%' }}>
                {c.characterName || '—'}
              </strong>
              <span style={{ flex: 1 }} />
              <span style={liveValueStyle}>{fmtDuration(elapsedMs)}</span>
            </div>
            {c.pubkey && (
              <div style={{ ...pubkeyCell, marginBottom: 6 }}>
                <code>{c.pubkey.slice(0, 16)}…</code>
              </div>
            )}
            {c.promptSnippet && (
              <div style={callPrompt} title={c.promptSnippet}>
                {c.promptSnippet.length > 200
                  ? c.promptSnippet.slice(0, 200) + '…'
                  : c.promptSnippet}
              </div>
            )}
            {!c.promptSnippet && c.extra?.tposeBytes && (
              <div style={{ ...callPrompt, color: 'var(--ink-faint)' }}>
                tpose input · {(c.extra.tposeBytes / 1024).toFixed(0)} KB
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function CallsTable({ calls, now, live }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1.5px solid var(--ink)' }}>
          <th style={th}>{live ? 'started' : 'completed'}</th>
          <th style={th}>character</th>
          <th style={th}>kind</th>
          <th style={th}>{live ? 'elapsed' : 'duration'}</th>
          {!live && <th style={th}>result</th>}
          <th style={th}>prompt / context</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c) => {
          const elapsedMs = live ? (now - c.startedAt) : c.durationMs
          return (
            <tr key={c.callId} style={{ borderBottom: '1px solid var(--ink-faint)' }}>
              <td style={td}>{fmtTime(live ? c.startedAt : c.completedAt)}</td>
              <td style={td}>
                {c.characterName || <span style={muted}>—</span>}
                {c.pubkey && <div style={pubkeyCell}><code>{c.pubkey.slice(0, 12)}…</code></div>}
              </td>
              <td style={td}><KindBadge kind={c.kind} /></td>
              <td style={td}>{fmtDuration(elapsedMs)}</td>
              {!live && (
                <td style={{ ...td, color: c.ok ? 'var(--ink)' : 'var(--transmit)' }}>
                  {c.ok
                    ? `ok${c.bytes ? ` · ${(c.bytes / 1024).toFixed(0)}KB` : ''}`
                    : `fail: ${(c.error || '').slice(0, 60)}`}
                </td>
              )}
              <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--ink-3)' }}>
                {c.promptSnippet
                  ? <span title={c.promptSnippet}>{c.promptSnippet.length > 80 ? c.promptSnippet.slice(0, 80) + '…' : c.promptSnippet}</span>
                  : c.extra?.tposeBytes
                    ? <span style={muted}>tpose input · {(c.extra.tposeBytes / 1024).toFixed(0)}KB</span>
                    : <span style={muted}>—</span>}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function KindBadge({ kind }) {
  if (!kind) return <span style={muted}>—</span>
  return (
    <span style={{
      background: 'var(--paper-3)',
      border: '1px solid var(--ink-faint)',
      padding: '1px 6px',
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
    }}>{kind}</span>
  )
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toISOString().slice(11, 19) + 'Z'
}
function fmtDuration(ms) {
  if (!ms || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

const sectionH2 = { marginTop: 0, marginBottom: 8, fontFamily: 'var(--font-display)', fontStretch: '75%', fontSize: 16, color: 'var(--ink)' }
const th = { padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-2)' }
const td = { padding: '6px 8px', verticalAlign: 'top' }
const muted = { color: 'var(--ink-faint)' }
const pubkeyCell = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-faint)' }
const emptyHint = {
  color: 'var(--ink-faint)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  padding: 12,
  border: '1px dashed var(--ink-faint)',
  background: 'var(--paper-2)',
}

/* ───── Page layout primitives (added in the redesign) ─── */

const pageStyle = {
  padding: 24,
  height: '100%',
  overflow: 'auto',
  maxWidth: 1100,
  margin: '0 auto',
}

const HERO_TONE = {
  warm:    { border: '2px solid var(--ink)', stripe: 'var(--transmit-2, #2da14a)' },
  warming: { border: '2px solid var(--ink)', stripe: '#cc8800' },
  cold:    { border: '2px solid var(--ink)', stripe: '#666' },
  failed:  { border: '2px solid var(--transmit)', stripe: 'var(--transmit, #c83b3b)' },
  unknown: { border: '2px dashed var(--ink-faint)', stripe: 'var(--ink-faint)' },
}
function heroStyle(status) {
  const t = HERO_TONE[status] || HERO_TONE.unknown
  return {
    display: 'flex',
    gap: 24,
    alignItems: 'flex-start',
    border: t.border,
    borderLeft: `8px solid ${t.stripe}`,
    background: 'var(--paper)',
    padding: '20px 24px',
    boxShadow: 'var(--shadow-card)',
  }
}

const heroEyebrow = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--ink-faint)',
  marginBottom: 4,
}

const heroTitle = {
  fontFamily: 'var(--font-display)',
  fontStretch: '75%',
  fontWeight: 800,
  fontSize: 32,
  lineHeight: 1.1,
  margin: 0,
  color: 'var(--ink)',
}

const heroDesc = {
  marginTop: 8,
  marginBottom: 0,
  fontSize: 14,
  color: 'var(--ink-3)',
  lineHeight: 1.5,
  maxWidth: 560,
}

const heroAction = {
  flex: '0 0 auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
}

const progressBanner = {
  marginTop: 12,
  padding: '12px 16px',
  border: '1.5px solid var(--ink)',
  background: 'var(--paper-2)',
}
const progressBarTrack = {
  height: 6,
  background: 'var(--paper-3)',
  border: '1px solid var(--ink)',
  position: 'relative',
  overflow: 'hidden',
}
const progressBarFill = {
  height: '100%',
  background: 'var(--violet, #6a4aa8)',
  transition: 'width 250ms linear',
}
const progressLabel = {
  marginTop: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
}

const errorBanner = {
  marginTop: 12,
  padding: '8px 12px',
  borderLeft: '3px solid var(--transmit)',
  background: 'var(--paper-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--transmit)',
}

const metricsGrid = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  marginTop: 20,
}
const metricLabel = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--ink-faint)',
}
const metricValue = {
  marginTop: 4,
  fontFamily: 'var(--font-display)',
  fontStretch: '75%',
  fontWeight: 700,
  fontSize: 22,
  lineHeight: 1.1,
  fontVariantNumeric: 'tabular-nums',
}
const metricSubLabel = {
  marginTop: 4,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-faint)',
}

const lifecycleRow = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 24,
  padding: '12px 16px',
  border: '1.5px solid var(--ink-faint)',
  background: 'var(--paper-2)',
}

const callCard = {
  padding: '12px 14px',
  border: '1.5px solid var(--ink)',
  background: 'var(--paper)',
  boxShadow: 'var(--shadow-card)',
}
const callPrompt = {
  marginTop: 8,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  lineHeight: 1.4,
  color: 'var(--ink-3)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 120,
  overflow: 'hidden',
}

const footerMeta = {
  marginTop: 32,
  fontSize: 11,
  color: 'var(--ink-faint)',
  fontFamily: 'var(--font-mono)',
  borderTop: '1px dashed var(--ink-faint)',
  paddingTop: 12,
}

/* Best-effort progress bar % from current wake stage. Tied to the
   stage's etaSeconds + elapsed time. */
function progressPctFromStage(stage, elapsedMs, fallbackEtaSec) {
  if (!stage) return 5
  if (stage.stage === 'done' || stage.stage === 'warm') return 100
  if (stage.stage === 'error') return 0
  const etaMs = (stage.etaSeconds || fallbackEtaSec || 60) * 1000
  return Math.min(95, Math.max(3, (elapsedMs / etaMs) * 100))
}

function StateBadge({ status, large }) {
  const colors = {
    warm: { bg: 'var(--transmit-2, #2da14a)', fg: '#fff' },
    warming: { bg: '#cc8800', fg: '#fff' },
    cold: { bg: '#666', fg: '#fff' },
    failed: { bg: 'var(--transmit, #c83b3b)', fg: '#fff' },
    unknown: { bg: 'var(--ink-faint, #888)', fg: '#fff' },
  }
  const c = colors[status] || colors.unknown
  return (
    <span style={{
      background: c.bg,
      color: c.fg,
      padding: large ? '4px 14px' : '2px 8px',
      fontFamily: 'var(--font-mono)',
      fontSize: large ? 13 : 11,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      border: '1px solid var(--ink)',
      fontWeight: large ? 700 : 600,
      display: 'inline-block',
    }}>{status}</span>
  )
}

function Stat({ label, children }) {
  return (
    <div style={statBox}>
      <div style={statLabel}>{label}</div>
      <div style={statValue}>{children}</div>
    </div>
  )
}

const statsRow = {
  marginTop: 24,
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
}
const statBox = {
  border: '1.5px solid var(--ink)',
  background: 'var(--paper)',
  padding: '8px 14px',
  minWidth: 110,
}
const statLabel = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--ink-faint)',
}
const statValue = {
  marginTop: 4,
  fontFamily: 'var(--font-display)',
  fontStretch: '75%',
  fontWeight: 700,
  fontSize: 18,
  color: 'var(--ink)',
}
const liveValueStyle = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 600,
  fontSize: 16,
  color: 'var(--ink)',
  fontVariantNumeric: 'tabular-nums',
}
const smallValueStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-2)',
}
const statSubLabel = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-faint)',
}

function formatRelative(ms) {
  if (ms == null) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

function renderStage(stage, elapsedMs) {
  if (!stage) return ''
  const elapsed = formatDuration(elapsedMs || stage.elapsedMs || 0)
  if (stage.stage === 'cold-start') return `cold start · ${elapsed} — ${stage.message || ''}`
  if (stage.stage === 'warming') return `warming · ${elapsed}`
  if (stage.stage === 'joining-warmup') return `joining warmup in progress · ${elapsed}`
  if (stage.stage === 'warm') return stage.message || 'warm'
  if (stage.stage === 'done') return `done in ${elapsed}`
  if (stage.stage === 'error') return `error: ${stage.message || ''}`
  return stage.message || stage.stage || ''
}

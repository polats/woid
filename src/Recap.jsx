import { useEffect, useMemo, useState } from 'react'
import config from './config.js'

const cfg = config.agentSandbox || {}

/**
 * Recap stack — pinned card on the Sandbox home showing the most
 * recently closed session's recap, with a collapsed list of past
 * recaps below. Polls /sessions every 8s.
 *
 * The first card is whichever session has a `recap` set most
 * recently. The current (in-flight) session also surfaces with a
 * "today" header showing event count + sim-clock so the user knows
 * the day is still being recorded.
 */
export default function Recap() {
  const [sessions, setSessions] = useState([])
  const [now, setNow] = useState(null)
  const [expanded, setExpanded] = useState(new Set())
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)  // null | 'inject' | 'rollover'

  useEffect(() => {
    if (!cfg.bridgeUrl) return
    let cancelled = false
    async function load() {
      try {
        const [s, c] = await Promise.all([
          fetch(`${cfg.bridgeUrl}/sessions`).then((r) => r.json()),
          fetch(`${cfg.bridgeUrl}/health/sim-clock`).then((r) => r.json()),
        ])
        if (cancelled) return
        setSessions(s.sessions || [])
        setNow(c)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(err.message || String(err))
      }
    }
    load()
    const t = setInterval(load, 8000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const open = useMemo(() => sessions.find((s) => !s.closed_at) || null, [sessions])
  const closed = useMemo(() => sessions.filter((s) => s.closed_at), [sessions])
  const latestWithRecap = closed.find((s) => s.recap)
  const olderClosed = closed.filter((s) => s !== latestWithRecap)

  function toggle(id) {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function injectTestEvents() {
    setBusy('inject')
    try {
      await fetch(`${cfg.bridgeUrl}/sessions/seed-events`, { method: 'POST' })
      // Poll once to refresh.
      const s = await fetch(`${cfg.bridgeUrl}/sessions`).then((r) => r.json())
      setSessions(s.sessions || [])
    } finally {
      setBusy(null)
    }
  }

  async function rolloverNow() {
    setBusy('rollover')
    try {
      await fetch(`${cfg.bridgeUrl}/sessions/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simHours: 24 }),
      })
      // Poll a few times — recap LLM call is async.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        const s = await fetch(`${cfg.bridgeUrl}/sessions`).then((r) => r.json())
        setSessions(s.sessions || [])
        if ((s.sessions || []).some((x) => x.recap_source && x.closed_at)) break
      }
    } finally {
      setBusy(null)
    }
  }

  if (error) return <div className="recap-stack-error">{error}</div>

  return (
    <div className="recap-stack">
      <div className="recap-actions">
        <button
          type="button"
          className="recap-action"
          onClick={injectTestEvents}
          disabled={!!busy || !open}
          title="Append three synthetic scene_close events to today's session so the next rollover has something to write about."
        >
          {busy === 'inject' ? 'injecting…' : 'Inject test events'}
        </button>
        <button
          type="button"
          className="recap-action"
          onClick={rolloverNow}
          disabled={!!busy}
          title="Force the sim-clock forward to the next day so the recap pipeline runs on the current session."
        >
          {busy === 'rollover' ? 'rolling over…' : 'Rollover now (24h)'}
        </button>
      </div>

      {open && (
        <article className="recap-card recap-card-open">
          <header className="recap-card-header">
            <strong>Today — {open.sim_iso_open}</strong>
            {now?.sim_iso && (
              <span className="muted">now: {now.sim_iso}</span>
            )}
          </header>
          <p className="recap-card-body muted">
            {open.events?.length
              ? `Today's recap will write itself at ${slotLabel(now?.slot)}'s end. ${open.events.length} event${open.events.length === 1 ? '' : 's'} captured so far.`
              : 'Quiet so far. Drop characters in to see them go about their day.'}
          </p>
        </article>
      )}

      {latestWithRecap && (
        <article className="recap-card recap-card-pinned">
          <header className="recap-card-header">
            <strong>Day {latestWithRecap.sim_day}</strong>
            <span className="muted">
              {latestWithRecap.sim_iso_close ?? ''}
              {latestWithRecap.recap_source === 'fallback' && ' · fallback'}
              {latestWithRecap.recap_model && ` · ${latestWithRecap.recap_model.split('/').pop()}`}
            </span>
          </header>
          <p className="recap-card-body">{latestWithRecap.recap}</p>
          <RecapEvents session={latestWithRecap} />
        </article>
      )}

      {!latestWithRecap && !open && !error && (
        <div className="recap-stack-empty muted">
          No sessions yet. The first recap will appear after the next
          sim-day rollover.
        </div>
      )}

      {olderClosed.length > 0 && (
        <details className="recap-past">
          <summary>{olderClosed.length} past recap{olderClosed.length === 1 ? '' : 's'}</summary>
          <ul className="recap-past-list">
            {olderClosed.map((s) => (
              <li key={s.id} className="recap-past-item">
                <button
                  className="recap-past-toggle"
                  onClick={() => toggle(s.id)}
                  aria-expanded={expanded.has(s.id)}
                >
                  <span className="muted">Day {s.sim_day}</span>
                  <span className="recap-past-preview">{s.recap?.slice(0, 80) || '(no recap)'}…</span>
                </button>
                {expanded.has(s.id) && (
                  <div className="recap-past-detail">
                    <p>{s.recap}</p>
                    <RecapEvents session={s} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function RecapEvents({ session }) {
  const events = session.events || []
  if (events.length === 0) return null
  return (
    <details className="recap-events">
      <summary>{events.length} source event{events.length === 1 ? '' : 's'}</summary>
      <ul className="recap-events-list">
        {events.map((e, i) => (
          <li key={i} className={`recap-event recap-event-${e.kind}`}>
            {renderEvent(e)}
          </li>
        ))}
      </ul>
    </details>
  )
}

function renderEvent(e) {
  if (e.kind === 'scene_close') {
    return (
      <>
        <span className="recap-event-kind">scene</span>
        <span className="muted">
          {(e.participants || []).map((p) => p.slice(0, 6)).join(' + ')}
          {' '}— {e.end_reason}
        </span>
        {e.last_line && (
          <em className="recap-event-line">"{e.last_line}"</em>
        )}
      </>
    )
  }
  return <code className="muted">{e.kind}</code>
}

function slotLabel(slot) {
  return slot || 'the session'
}

import { useEffect, useState } from 'react'

const SESSIONS_BASE = '/api/testing/sessions'

export default function Testing({ initialSession }) {
  const [sessions, setSessions] = useState([])
  const [currentName, setCurrentName] = useState(initialSession || null)
  const [currentDetail, setCurrentDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  async function loadSessions() {
    setLoading(true)
    setLoadError(null)
    try {
      const r = await fetch(`${SESSIONS_BASE}/`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const list = await r.json()
      setSessions(list)
      if (list.length > 0 && !currentName) setCurrentName(list[0].name)
    } catch (err) {
      setLoadError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadSessions() }, [])

  useEffect(() => {
    if (!currentName) { setCurrentDetail(null); return }
    let cancelled = false
    fetch(`${SESSIONS_BASE}/${currentName}/session.json`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (!cancelled) setCurrentDetail(data) })
      .catch(() => { if (!cancelled) setCurrentDetail(null) })
    if (window.location.hash !== `#/testing/${currentName}`) {
      window.location.hash = `#/testing/${currentName}`
    }
    return () => { cancelled = true }
  }, [currentName])

  return (
    <div className="testing-view">
      <aside className="testing-sidebar">
        <div className="testing-sidebar-header">
          <h2>Sessions</h2>
          <button onClick={loadSessions} title="Refresh">↻</button>
        </div>
        {loadError && <p className="testing-error">{loadError}</p>}
        {!loadError && sessions.length === 0 && !loading && (
          <p className="muted">
            No sessions yet. Run <code>npm run test:e2e</code>.
          </p>
        )}
        <ul className="testing-session-list">
          {sessions.map((s) => (
            <li
              key={s.name}
              className={`testing-session-item${currentName === s.name ? ' active' : ''}`}
              onClick={() => setCurrentName(s.name)}
              role="button"
              tabIndex={0}
            >
              <div className="testing-session-name">
                <span className={`testing-badge ${s.pass ? 'pass' : 'fail'}`}>
                  {s.pass ? 'PASS' : 'FAIL'}
                </span>
                {s.name}
              </div>
              <div className="testing-session-meta">
                {s.passCount}/{s.testCount} passed · {(s.duration / 1000).toFixed(1)}s
                {' · '}{new Date(s.date).toLocaleTimeString()}
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <section className="testing-main">
        {!currentDetail ? (
          <div className="testing-empty">
            {currentName ? <p>Loading {currentName}…</p> : <p>Select a session on the left.</p>}
          </div>
        ) : (
          <>
            <header className="testing-session-header">
              <h2>{currentDetail.name}</h2>
              <div className="muted">
                {currentDetail.tests.length} tests · {(currentDetail.duration / 1000).toFixed(1)}s ·{' '}
                {new Date(currentDetail.date).toLocaleString()}
              </div>
            </header>
            {currentDetail.tests.map((t, i) => (
              <article
                key={i}
                className={`testing-test-card${t.ok ? ' ok' : ' fail'}`}
              >
                <div className="testing-test-header">
                  <div className="testing-test-title">
                    <span className={`testing-badge ${t.ok ? 'pass' : 'fail'}`}>
                      {t.ok ? 'PASS' : 'FAIL'}
                    </span>
                    {t.title}
                  </div>
                  <code className="testing-test-duration">{(t.duration / 1000).toFixed(2)}s</code>
                </div>
                {t.spec && (
                  <code className="testing-test-spec muted" title="source location">
                    {t.spec}
                  </code>
                )}
                {t.summary && (
                  <p className="testing-test-summary">{t.summary}</p>
                )}
                {t.videoFilename ? (
                  <div className="testing-video">
                    <video
                      src={`${SESSIONS_BASE}/${currentDetail.name}/${t.videoFilename}`}
                      controls
                      preload="metadata"
                    />
                  </div>
                ) : (
                  <div className="testing-no-video">No video for this test.</div>
                )}
                {Array.isArray(t.steps) && t.steps.length > 0 && (
                  <div className="testing-test-steps">
                    <h4>Steps</h4>
                    <ol>
                      {t.steps.map((s, j) => (
                        <li key={j} className={`testing-step${s.ok === false ? ' fail' : s.ok ? ' ok' : ''}`}>
                          <span className="testing-step-marker">
                            {s.ok === false ? '✖' : s.ok === true ? '✓' : '·'}
                          </span>
                          <span className="testing-step-label">{s.label}</span>
                          {s.detail && (
                            <span className="testing-step-detail muted">— {s.detail}</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {t.artifacts && (
                  <details className="testing-test-artifacts">
                    <summary>Artifacts</summary>
                    <ArtifactsBlock data={t.artifacts} />
                  </details>
                )}
                {t.error && (
                  <pre className="testing-error-box">{t.error}</pre>
                )}
              </article>
            ))}
          </>
        )}
      </section>
    </div>
  )
}

/**
 * Pretty-printer for a test's `artifacts` blob — recursive, with a
 * special-case for known shapes (character, nudge, movement) so they
 * render as formatted lines instead of raw JSON.
 */
function ArtifactsBlock({ data }) {
  if (!data || typeof data !== 'object') return null
  return (
    <div className="testing-artifacts">
      {data.character && (
        <div className="testing-artifact-row">
          <span className="testing-artifact-key">character</span>
          <div className="testing-artifact-val">
            <strong>{data.character.name || data.character.pubkey?.slice(0, 8)}</strong>
            {data.character.about && (
              <em className="muted"> — {data.character.about}</em>
            )}
            {data.character.pubkey && (
              <code className="muted"> {data.character.pubkey.slice(0, 12)}…</code>
            )}
          </div>
        </div>
      )}
      {data.nudge && (
        <div className="testing-artifact-row">
          <span className="testing-artifact-key">schedule_nudge</span>
          <div className="testing-artifact-val">
            slot=<strong>{data.nudge.slot}</strong>
            {' '}→ {data.nudge.target_room_name || data.nudge.target_room_id}
            <code className="muted"> ({data.nudge.target_x}, {data.nudge.target_y})</code>
          </div>
        </div>
      )}
      {data.movement && (
        <div className="testing-artifact-row">
          <span className="testing-artifact-key">movement</span>
          <div className="testing-artifact-val">
            <code>{posLabel(data.movement.start)}</code>
            {' → '}
            <code>{posLabel(data.movement.end)}</code>
            {Number.isFinite(data.movement.elapsed_ms) && (
              <span className="muted"> in {(data.movement.elapsed_ms / 1000).toFixed(1)}s</span>
            )}
          </div>
        </div>
      )}
      {Array.isArray(data.moodlets) && data.moodlets.length > 0 && (
        <div className="testing-artifact-row">
          <span className="testing-artifact-key">moodlets</span>
          <div className="testing-artifact-val">
            {data.moodlets.map((m, k) => (
              <div key={k} className={`testing-artifact-moodlet ${m.weight >= 0 ? 'pos' : 'neg'}`}>
                <code>{m.weight >= 0 ? '+' : ''}{m.weight}</code>
                {' '}<strong>{m.tag}</strong>
                {m.reason && <span className="muted"> — {m.reason}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {data.scene && (
        <div className="testing-artifact-row">
          <span className="testing-artifact-key">scene</span>
          <div className="testing-artifact-val">
            <code>{data.scene.scene_id}</code>
            <span className="muted"> · {data.scene.end_reason} · {data.scene.summary_source}</span>
          </div>
        </div>
      )}
      {data.notes && (
        <div className="testing-artifact-row">
          <span className="testing-artifact-key">notes</span>
          <div className="testing-artifact-val muted">{data.notes}</div>
        </div>
      )}
    </div>
  )
}

function posLabel(p) {
  if (!p) return '?'
  const r = p.room_id ? `${p.room_id} ` : ''
  return `${r}(${p.x}, ${p.y})`
}

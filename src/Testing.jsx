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

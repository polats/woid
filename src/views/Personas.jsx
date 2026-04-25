import { useEffect, useState, useCallback } from 'react'
import config from '../config.js'

const PAGE = 50

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

export default function Personas() {
  const bridgeUrl = config.agentSandbox?.bridgeUrl
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [nextCursor, setNextCursor] = useState(null)
  const [selected, setSelected] = useState(null)
  const [status, setStatus] = useState(null)
  const [loadErr, setLoadErr] = useState(null)

  const refresh = useCallback(async (c = 0) => {
    if (!bridgeUrl) return
    try {
      const r = await fetch(`${bridgeUrl}/v1/personas/log?limit=${PAGE}&cursor=${c}`)
      if (!r.ok) throw new Error(String(r.status))
      const json = await r.json()
      setItems(json.items || [])
      setTotal(json.total ?? 0)
      setNextCursor(json.nextCursor)
      setCursor(c)
      setLoadErr(null)
    } catch (e) {
      setLoadErr(e.message || String(e))
    }
  }, [bridgeUrl])

  useEffect(() => { refresh(0) }, [refresh])

  useEffect(() => {
    if (!bridgeUrl) return
    let cancelled = false
    async function tick() {
      try {
        const r = await fetch(`${bridgeUrl}/v1/personas/status`)
        if (!r.ok) return
        const json = await r.json()
        if (!cancelled) setStatus(json)
      } catch { /* ignore */ }
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [bridgeUrl])

  async function openRow(id) {
    try {
      const r = await fetch(`${bridgeUrl}/v1/personas/log/${id}`)
      if (!r.ok) throw new Error(String(r.status))
      setSelected(await r.json())
    } catch (e) {
      setSelected({ id, error: e.message || String(e) })
    }
  }

  if (!bridgeUrl) return <p style={{ padding: 32 }}>Bridge URL not configured.</p>

  const q = status?.quota
  const recent = status?.recent

  return (
    <div className="personas-view" style={{ padding: 24, display: 'flex', gap: 24, height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <h1 style={{ marginTop: 0 }}>Persona generations</h1>
        <div style={{ display: 'flex', gap: 24, fontSize: 13, marginBottom: 12, flexWrap: 'wrap' }}>
          <div>
            <strong>Rate limit:</strong>{' '}
            {q ? `${q.currentTokens} / ${q.perMinute} available (per min)` : '—'}
          </div>
          <div>
            <strong>24h:</strong>{' '}
            {recent ? `${recent.ok24h} ok / ${recent.fail24h} failed` : '—'}
            {recent?.p50ms != null && <span style={{ opacity: 0.6 }}> · p50 {recent.p50ms}ms</span>}
          </div>
        </div>

        {loadErr && <p style={{ color: 'crimson' }}>Failed to load log: {loadErr}</p>}

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
              <th style={{ padding: '6px 8px' }}>When</th>
              <th style={{ padding: '6px 8px' }}>Model</th>
              <th style={{ padding: '6px 8px' }}>Name</th>
              <th style={{ padding: '6px 8px' }}>Status</th>
              <th style={{ padding: '6px 8px' }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr
                key={row.id}
                onClick={() => openRow(row.id)}
                style={{
                  cursor: 'pointer',
                  borderBottom: '1px solid #eee',
                  background: selected?.id === row.id ? 'var(--paper-3, #f3f3f3)' : 'transparent',
                }}
              >
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmtTime(row.ts)}</td>
                <td style={{ padding: '6px 8px' }}><code>{row.model || '—'}</code></td>
                <td style={{ padding: '6px 8px' }}>{row.name || ''}</td>
                <td style={{ padding: '6px 8px', color: row.ok ? '#2da14a' : '#c83b3b' }}>
                  {row.ok ? 'ok' : `fail: ${(row.error || '').slice(0, 60)}`}
                </td>
                <td style={{ padding: '6px 8px' }}>{row.durationMs}ms</td>
              </tr>
            ))}
            {items.length === 0 && !loadErr && (
              <tr><td colSpan={5} style={{ padding: 12, opacity: 0.6 }}>No generations yet.</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => refresh(Math.max(0, cursor - PAGE))}
            disabled={cursor === 0}
          >
            ← Newer
          </button>
          <button
            type="button"
            onClick={() => nextCursor != null && refresh(nextCursor)}
            disabled={nextCursor == null}
          >
            Older →
          </button>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {total} total · showing {cursor + 1}–{cursor + items.length}
          </span>
          <button type="button" onClick={() => refresh(cursor)} style={{ marginLeft: 'auto' }}>
            Refresh
          </button>
        </div>
      </div>

      <aside
        style={{
          width: 380,
          flexShrink: 0,
          borderLeft: '1px solid #ddd',
          paddingLeft: 16,
          overflow: 'auto',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Detail</h2>
        {!selected && <p style={{ opacity: 0.6, fontSize: 13 }}>Click a row to inspect.</p>}
        {selected && (
          <div style={{ fontSize: 13 }}>
            <div><strong>id:</strong> <code>{selected.id}</code></div>
            <div><strong>ts:</strong> {fmtTime(selected.ts)}</div>
            {selected.model && <div><strong>model:</strong> <code>{selected.model}</code></div>}
            {selected.durationMs != null && <div><strong>duration:</strong> {selected.durationMs}ms</div>}
            {selected.seedHash && <div><strong>seed hash:</strong> <code>{selected.seedHash}</code></div>}
            {selected.name && <div><strong>name:</strong> {selected.name}</div>}
            {selected.npub && (
              <div>
                <strong>npub:</strong> <code style={{ fontSize: 11 }}>{selected.npub.slice(0, 16)}…</code>
              </div>
            )}
            {selected.jumbleUrl && (
              <div style={{ marginTop: 4 }}>
                <a href={selected.jumbleUrl} target="_blank" rel="noreferrer">View on Jumble →</a>
              </div>
            )}
            {selected.about && (
              <div style={{ marginTop: 8 }}>
                <strong>about:</strong>
                <p style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{selected.about}</p>
              </div>
            )}
            {selected.imageUrl && (
              <div style={{ marginTop: 8 }}>
                <strong>image:</strong>
                <div style={{ marginTop: 4 }}>
                  <img
                    src={selected.imageUrl}
                    alt="generated avatar"
                    style={{ maxWidth: '100%', border: '1px solid #ddd' }}
                  />
                </div>
              </div>
            )}
            {selected.error && (
              <div style={{ marginTop: 8, color: '#c83b3b' }}>
                <strong>error:</strong> {selected.error}
              </div>
            )}
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.7 }}>Raw JSON</summary>
              <pre style={{ fontSize: 11, overflow: 'auto', marginTop: 4 }}>
                {JSON.stringify(selected, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </aside>
    </div>
  )
}

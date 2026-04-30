import { useEffect, useState, useCallback } from 'react'
import config from '../config.js'
import { eventUrl } from '../lib/jumble.js'
import { lanUrl } from '../lib/lanUrl.js'

const PAGE = 50
const JUMBLE_URL = config.agentSandbox?.jumbleUrl || 'http://localhost:18089'

/**
 * Image posts log (#415) — every kind:1 with NIP-94 imeta the
 * characters have produced. Mirror of Personas.jsx in shape, but
 * surfaced as a thumbnail grid (the visual is the point).
 */
export default function ImagePosts() {
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
      const r = await fetch(`${bridgeUrl}/image-posts?limit=${PAGE}&cursor=${c}`)
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
        const r = await fetch(`${bridgeUrl}/image-posts/status`)
        if (!r.ok) return
        const json = await r.json()
        if (!cancelled) setStatus(json)
      } catch { /* ignore */ }
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [bridgeUrl])

  if (!bridgeUrl) return <p style={{ padding: 32 }}>Bridge URL not configured.</p>

  const characterCount = status?.by_character ? Object.keys(status.by_character).length : 0

  return (
    <div className="image-posts-view">
      <div className="image-posts-main">
        <h1>Image posts</h1>
        <div className="image-posts-meta">
          <div>
            <strong>Total:</strong> {status?.count ?? items.length} post{(status?.count ?? items.length) === 1 ? '' : 's'}
          </div>
          {characterCount > 0 && (
            <div>
              <strong>Characters:</strong> {characterCount}
            </div>
          )}
          {status?.latest_actor_name && (
            <div className="muted">
              latest: {status.latest_actor_name} · {status.latest_sim_iso}
            </div>
          )}
        </div>

        {loadErr && <p className="image-posts-err">Failed to load: {loadErr}</p>}

        {items.length === 0 && !loadErr && (
          <p className="image-posts-empty">
            No image posts yet — wait for a <code>something-to-share</code> card to fire,
            or force one from the Storyteller tab.
          </p>
        )}

        <div className="image-posts-grid">
          {items.map((row) => {
            const active = selected?.event_id === row.event_id
            return (
              <button
                key={row.event_id || row.image_url}
                type="button"
                className={`image-posts-tile${active ? ' active' : ''}`}
                onClick={() => setSelected(row)}
                title={`${row.actor_name}: ${row.text}`}
              >
                <div className="image-posts-tile-thumb">
                  <img src={lanUrl(row.image_url)} alt={row.text} loading="lazy" />
                </div>
                <div className="image-posts-tile-meta">
                  <strong>{row.actor_name}</strong>
                  <span className="muted">{row.sim_iso}</span>
                  <p className="image-posts-tile-text">{row.text}</p>
                </div>
              </button>
            )
          })}
        </div>

        {(nextCursor != null || cursor > 0) && (
          <div className="image-posts-pager">
            <button
              type="button"
              onClick={() => refresh(Math.max(0, cursor - PAGE))}
              disabled={cursor === 0}
            >← Newer</button>
            <button
              type="button"
              onClick={() => nextCursor != null && refresh(nextCursor)}
              disabled={nextCursor == null}
            >Older →</button>
            <span className="muted">
              {total} total · showing {items.length === 0 ? 0 : cursor + 1}–{cursor + items.length}
            </span>
            <button type="button" onClick={() => refresh(cursor)} className="image-posts-refresh">Refresh</button>
          </div>
        )}
      </div>

      <aside className="image-posts-detail">
        <h2>Detail</h2>
        {!selected && <p className="muted">Click a tile to inspect.</p>}
        {selected && (
          <div className="image-posts-detail-body">
            <a
              href={lanUrl(selected.image_url)}
              target="_blank"
              rel="noreferrer"
              className="image-posts-detail-imgwrap"
              title="Open full-size image"
            >
              <img src={lanUrl(selected.image_url)} alt={selected.text} />
            </a>
            <dl>
              <dt>actor</dt>
              <dd>{selected.actor_name} <code className="muted">{selected.actor_pubkey?.slice(0, 12)}…</code></dd>
              <dt>when</dt>
              <dd>{selected.sim_iso} <span className="muted">(Day {selected.sim_day})</span></dd>
              {selected.text && (<><dt>text</dt><dd>{selected.text}</dd></>)}
              {selected.image_prompt && (
                <>
                  <dt>image prompt</dt>
                  <dd className="image-posts-prompt">{selected.image_prompt}</dd>
                </>
              )}
              {selected.event_id && (
                <>
                  <dt>event id</dt>
                  <dd><code>{selected.event_id.slice(0, 16)}…</code></dd>
                </>
              )}
            </dl>
            {selected.event_id && (
              <a
                className="image-posts-jumble"
                href={eventUrl(JUMBLE_URL, selected.event_id, { author: selected.actor_pubkey, kind: 1 })}
                target="_blank"
                rel="noreferrer"
              >
                Open on Jumble →
              </a>
            )}
            <details className="image-posts-raw">
              <summary>Raw JSON</summary>
              <pre>{JSON.stringify(selected, null, 2)}</pre>
            </details>
          </div>
        )}
      </aside>
    </div>
  )
}

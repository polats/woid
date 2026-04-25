import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { forceCollide, forceManyBody } from 'd3-force'
import config from '../config.js'
import { profileUrl } from '../lib/jumble.js'

const ForceGraph2D = lazy(() => import('react-force-graph-2d'))

const cfg = config.agentSandbox || {}

// Brand palette pulled from styles.css :root tokens. Canvas paint can't
// read CSS vars cheaply, so we mirror the values directly.
const BRAND = {
  paper: '#f3ebdc',
  card: '#fbf6ea',
  paperEdge: '#e2d6ba',
  ink: '#141821',
  inkMuted: '#6d6a5f',
  inkFaint: '#8a8574',
  transmit: '#d8271a',
  prussian: '#0b2a4a',
}

function shortPubkey(pk) {
  return pk ? pk.slice(0, 8) + '…' + pk.slice(-4) : ''
}

function safeNpub(pk) {
  try { return nip19.npubEncode(pk) } catch { return null }
}

function fetchRelay({ url, kinds, limit, onEvent, onEose }) {
  const subId = 'net-' + Math.random().toString(36).slice(2, 10)
  const ws = new WebSocket(url)
  ws.onopen = () => {
    try { ws.send(JSON.stringify(['REQ', subId, { kinds, limit }])) } catch {}
  }
  ws.onmessage = (m) => {
    let msg
    try { msg = JSON.parse(m.data) } catch { return }
    if (!Array.isArray(msg) || msg[1] !== subId) return
    if (msg[0] === 'EVENT') onEvent(msg[2])
    else if (msg[0] === 'EOSE') { onEose(); try { ws.close() } catch {} }
  }
  return () => { try { ws.close() } catch {} }
}

export default function Network() {
  const [profiles, setProfiles] = useState({})
  const [follows, setFollows] = useState({})
  const [loadStatus, setLoadStatus] = useState({ profiles: 'loading', follows: 'loading' })
  const [selectedPk, setSelectedPk] = useState(null)
  const [hoverNode, setHoverNode] = useState(null)
  const [search, setSearch] = useState('')
  const containerRef = useRef(null)
  const graphRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 500 })
  const imageCache = useRef({})

  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    g.d3Force('charge', forceManyBody().strength(-220).distanceMax(420))
    g.d3Force('collide', forceCollide((n) => 22 + Math.min(n.followCount || 0, 12)))
    const link = g.d3Force('link')
    if (link) { link.distance(120).strength(0.12) }
    g.d3ReheatSimulation()
  }, [graphRef.current, profiles, follows])

  useEffect(() => {
    function measure() {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      setDimensions({ width: rect.width, height: Math.max(420, window.innerHeight - 220) })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    if (!cfg.relayUrl) return
    const profMap = {}
    const followMap = {}

    const stop0 = fetchRelay({
      url: cfg.relayUrl,
      kinds: [0],
      limit: 500,
      onEvent: (ev) => {
        try {
          const meta = JSON.parse(ev.content)
          const cur = profMap[ev.pubkey]
          if (!cur || cur._ts < ev.created_at) {
            profMap[ev.pubkey] = {
              name: meta.display_name || meta.name || shortPubkey(ev.pubkey),
              picture: meta.picture || null,
              about: (meta.about || '').slice(0, 280),
              _ts: ev.created_at,
            }
          }
        } catch { /* skip malformed */ }
      },
      onEose: () => {
        setProfiles({ ...profMap })
        setLoadStatus((s) => ({ ...s, profiles: 'done' }))
      },
    })

    const stop3 = fetchRelay({
      url: cfg.relayUrl,
      kinds: [3],
      limit: 500,
      onEvent: (ev) => {
        const cur = followMap[ev.pubkey]
        if (cur && cur._ts >= ev.created_at) return
        followMap[ev.pubkey] = {
          follows: ev.tags.filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1])).map((t) => t[1]),
          _ts: ev.created_at,
        }
      },
      onEose: () => {
        setFollows({ ...followMap })
        setLoadStatus((s) => ({ ...s, follows: 'done' }))
      },
    })

    return () => { stop0(); stop3() }
  }, [])

  const graphData = useMemo(() => {
    const nodes = Object.entries(profiles).map(([pk, p]) => ({
      id: pk,
      name: p.name,
      picture: p.picture,
      about: p.about,
      followCount: follows[pk]?.follows?.filter((f) => profiles[f]).length || 0,
    }))
    const edges = []
    for (const [src, data] of Object.entries(follows)) {
      if (!profiles[src]) continue
      for (const tgt of data.follows || []) {
        if (profiles[tgt] && src !== tgt) edges.push({ source: src, target: tgt })
      }
    }
    return { nodes, links: edges }
  }, [profiles, follows])

  useEffect(() => {
    for (const node of graphData.nodes) {
      if (node.picture && !imageCache.current[node.picture]) {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.src = node.picture
        imageCache.current[node.picture] = img
      }
    }
  }, [graphData.nodes])

  function paintNode(node, ctx, globalScale) {
    const r = 7 + Math.min(node.followCount, 8)
    const img = node.picture ? imageCache.current[node.picture] : null
    const isSelected = node.id === selectedPk
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.closePath()
      ctx.clip()
      try { ctx.drawImage(img, node.x - r, node.y - r, r * 2, r * 2) } catch {}
      ctx.restore()
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.lineWidth = isSelected ? 2.5 : 1.25
      ctx.strokeStyle = isSelected ? BRAND.transmit : BRAND.ink
      ctx.stroke()
    } else {
      ctx.fillStyle = isSelected ? BRAND.transmit : BRAND.prussian
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = BRAND.ink
      ctx.stroke()
    }
    const label = node.name || ''
    const fontSize = Math.max(10, 11 / Math.max(globalScale, 0.6))
    ctx.font = `500 ${fontSize}px "Space Grotesk", system-ui, sans-serif`
    const textW = ctx.measureText(label).width
    const padX = 5
    const padY = 3
    const labelY = node.y + r + 4
    ctx.fillStyle = BRAND.paper
    ctx.fillRect(node.x - textW / 2 - padX, labelY, textW + padX * 2, fontSize + padY * 2)
    ctx.strokeStyle = BRAND.inkFaint
    ctx.lineWidth = 0.6
    ctx.strokeRect(node.x - textW / 2 - padX, labelY, textW + padX * 2, fontSize + padY * 2)
    ctx.fillStyle = BRAND.ink
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(label, node.x, labelY + padY)
  }

  const selectedProfile = selectedPk ? profiles[selectedPk] : null
  const selectedFollows = selectedPk
    ? (follows[selectedPk]?.follows || []).filter((p) => profiles[p])
    : []
  const selectedFollowedBy = useMemo(() => {
    if (!selectedPk) return []
    return Object.entries(follows)
      .filter(([src, d]) => src !== selectedPk && d.follows?.includes(selectedPk) && profiles[src])
      .map(([src]) => src)
  }, [selectedPk, follows, profiles])

  const selectedJumbleUrl = selectedPk ? profileUrl(cfg.jumbleUrl, selectedPk) : null

  const directoryList = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = Object.entries(profiles).map(([pk, p]) => ({
      pk,
      name: p.name,
      picture: p.picture,
      followCount: follows[pk]?.follows?.filter((f) => profiles[f]).length || 0,
    }))
    const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows
    return filtered.sort((a, b) => b.followCount - a.followCount || a.name.localeCompare(b.name))
  }, [profiles, follows, search])

  const ready = loadStatus.profiles === 'done' && loadStatus.follows === 'done'

  if (!cfg.relayUrl) {
    return <p style={{ padding: 32 }}>Relay URL not configured.</p>
  }

  return (
    <div className="network-view">
      <header>
        <h1>Network</h1>
        <div className="network-view-meta">
          <span><strong>{graphData.nodes.length}</strong> users</span>
          <span><strong>{graphData.links.length}</strong> follows</span>
          <span>{ready ? <code>{cfg.relayUrl}</code> : 'loading…'}</span>
        </div>
      </header>

      <div className="network-layout">
        <div className="network-directory">
          <div className="network-directory-search">
            <input
              type="text"
              placeholder={`Search ${directoryList.length} characters…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="network-directory-list">
            {directoryList.map((r) => (
              <button
                key={r.pk}
                type="button"
                className={`network-directory-row${selectedPk === r.pk ? ' selected' : ''}`}
                onClick={() => setSelectedPk(selectedPk === r.pk ? null : r.pk)}
              >
                <div className="network-directory-avatar">
                  {r.picture
                    ? <img src={r.picture} alt="" />
                    : <span>{(r.name || '?').charAt(0).toUpperCase()}</span>}
                </div>
                <div className="network-directory-info">
                  <div className="network-directory-name">{r.name}</div>
                  <div className="network-directory-meta">{r.followCount} following</div>
                </div>
              </button>
            ))}
            {directoryList.length === 0 && (
              <div className="network-directory-empty">No matches.</div>
            )}
          </div>
        </div>

        <div className="network-graph" ref={containerRef}>
          {graphData.nodes.length === 0 && (
            <div className="network-graph-empty">
              {ready ? 'No characters published kind:0 yet.' : 'Loading…'}
            </div>
          )}
          <Suspense fallback={<div className="network-graph-empty">Loading graph…</div>}>
            <ForceGraph2D
              ref={graphRef}
              graphData={graphData}
              width={dimensions.width}
              height={dimensions.height}
              backgroundColor="rgba(0,0,0,0)"
              nodeCanvasObject={paintNode}
              nodePointerAreaPaint={(node, color, ctx) => {
                const r = 7 + Math.min(node.followCount, 8)
                ctx.fillStyle = color
                ctx.beginPath()
                ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
                ctx.fill()
              }}
              linkColor={() => 'rgba(20, 24, 33, 0.22)'}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={0.85}
              onNodeHover={(n) => setHoverNode(n || null)}
              onNodeClick={(n) => setSelectedPk(selectedPk === n.id ? null : n.id)}
              cooldownTime={4000}
            />
          </Suspense>
          {hoverNode && hoverNode.id !== selectedPk && (
            <div className="network-tooltip">
              <strong>{hoverNode.name}</strong>
              {hoverNode.about && <p>{hoverNode.about}</p>}
              <span className="network-tooltip-meta">{hoverNode.followCount} following</span>
            </div>
          )}
        </div>

        <aside className="network-detail">
          {!selectedPk && (
            <div className="network-detail-empty">Click a node to inspect.</div>
          )}
          {selectedPk && selectedProfile && (
            <div>
              <div className="network-detail-header">
                <div className="network-detail-avatar">
                  {selectedProfile.picture
                    ? <img src={selectedProfile.picture} alt="" />
                    : <span>{(selectedProfile.name || '?').charAt(0).toUpperCase()}</span>}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="network-detail-name">{selectedProfile.name}</div>
                  <div className="network-detail-pubkey">{shortPubkey(selectedPk)}</div>
                </div>
              </div>
              {selectedProfile.about && (
                <p className="network-detail-about">{selectedProfile.about}</p>
              )}
              {selectedJumbleUrl && (
                <a className="network-jumble-link" href={selectedJumbleUrl} target="_blank" rel="noreferrer">
                  View on Jumble →
                </a>
              )}
              <div className="network-detail-section">
                <span className="network-detail-section-label">npub</span>
                <code className="network-detail-npub">{safeNpub(selectedPk)}</code>
              </div>
              {selectedFollows.length > 0 && (
                <div className="network-detail-section">
                  <span className="network-detail-section-label">Following ({selectedFollows.length})</span>
                  <div className="network-chip-list">
                    {selectedFollows.map((pk) => (
                      <button
                        key={pk}
                        type="button"
                        className="network-chip"
                        onClick={() => setSelectedPk(pk)}
                      >
                        {profiles[pk].name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {selectedFollowedBy.length > 0 && (
                <div className="network-detail-section">
                  <span className="network-detail-section-label">Followed by ({selectedFollowedBy.length})</span>
                  <div className="network-chip-list">
                    {selectedFollowedBy.map((pk) => (
                      <button
                        key={pk}
                        type="button"
                        className="network-chip"
                        onClick={() => setSelectedPk(pk)}
                      >
                        {profiles[pk].name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

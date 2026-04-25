import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { forceCollide, forceManyBody } from 'd3-force'
import config from '../config.js'
import { profileUrl } from '../lib/jumble.js'

const ForceGraph2D = lazy(() => import('react-force-graph-2d'))

const cfg = config.agentSandbox || {}

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
  const [profiles, setProfiles] = useState({}) // pubkey -> { name, picture, about, _ts }
  const [follows, setFollows] = useState({})   // pubkey -> { follows: [pk], _ts }
  const [loadStatus, setLoadStatus] = useState({ profiles: 'loading', follows: 'loading' })
  const [selectedPk, setSelectedPk] = useState(null)
  const [hoverNode, setHoverNode] = useState(null)
  const [search, setSearch] = useState('')
  const containerRef = useRef(null)
  const graphRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 500 })
  const imageCache = useRef({})

  // Tune the force layout: stronger repulsion + collide radius keep
  // followers from clumping on top of a heavily-followed admin node,
  // and longer link distance gives names room to breathe.
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    g.d3Force('charge', forceManyBody().strength(-220).distanceMax(420))
    g.d3Force('collide', forceCollide((n) => 22 + Math.min(n.followCount || 0, 12)))
    const link = g.d3Force('link')
    if (link) { link.distance(120).strength(0.12) }
    g.d3ReheatSimulation()
  }, [graphRef.current, profiles, follows])

  // Resize observer for the graph container.
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

  // Fetch kind:0 (profiles) and kind:3 (follows) once on mount.
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
        } catch { /* skip malformed kind:0 */ }
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

  // Build nodes + edges for the graph.
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

  // Avatar pre-cache for the canvas paint function.
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
    const r = 6 + Math.min(node.followCount, 8)
    const img = node.picture ? imageCache.current[node.picture] : null
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
      ctx.lineWidth = node.id === selectedPk ? 2 : 1
      ctx.strokeStyle = node.id === selectedPk ? '#000' : 'rgba(0,0,0,0.3)'
      ctx.stroke()
    } else {
      ctx.fillStyle = node.id === selectedPk ? '#000' : '#888'
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.fill()
    }
    // Always render the name beneath the node, with a translucent
    // pill behind it so labels stay legible over crossing links.
    const label = node.name || ''
    const fontSize = Math.max(10, 11 / Math.max(globalScale, 0.6))
    ctx.font = `${fontSize}px sans-serif`
    const textW = ctx.measureText(label).width
    const padX = 4
    const padY = 2
    const labelY = node.y + r + 4
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillRect(node.x - textW / 2 - padX, labelY, textW + padX * 2, fontSize + padY * 2)
    ctx.fillStyle = '#000'
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

  if (!cfg.relayUrl) {
    return <p style={{ padding: 32 }}>Relay URL not configured.</p>
  }

  return (
    <div className="network-view" style={{ padding: 24, height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ marginTop: 0, marginBottom: 4 }}>Network</h1>
        <div style={{ display: 'flex', gap: 16, fontSize: 13, color: '#555' }}>
          <span><strong>{graphData.nodes.length}</strong> users</span>
          <span><strong>{graphData.links.length}</strong> follows</span>
          <span style={{ opacity: 0.6 }}>
            {loadStatus.profiles === 'done' && loadStatus.follows === 'done'
              ? `via ${cfg.relayUrl}`
              : 'loading…'}
          </span>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        <div style={{
          width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column',
          border: '1px solid #ddd', minHeight: 0,
        }}>
          <div style={{ padding: 8, borderBottom: '1px solid #eee' }}>
            <input
              type="text"
              placeholder={`Search ${directoryList.length} characters…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: '100%', padding: '4px 6px', fontSize: 12 }}
            />
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {directoryList.map((r) => (
              <button
                key={r.pk}
                type="button"
                onClick={() => setSelectedPk(selectedPk === r.pk ? null : r.pk)}
                style={{
                  width: '100%',
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px', fontSize: 12,
                  border: 0, borderBottom: '1px solid #f0f0f0',
                  background: selectedPk === r.pk ? '#eef' : 'white',
                  textAlign: 'left', cursor: 'pointer',
                }}
              >
                {r.picture ? (
                  <img src={r.picture} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                ) : (
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%',
                    background: '#ddd', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 600,
                  }}>{(r.name || '?').charAt(0).toUpperCase()}</div>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                  <div style={{ fontSize: 10, opacity: 0.6 }}>{r.followCount} following</div>
                </div>
              </button>
            ))}
            {directoryList.length === 0 && (
              <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>No matches.</div>
            )}
          </div>
        </div>

        <div ref={containerRef} style={{ flex: 1, minWidth: 0, position: 'relative', border: '1px solid #ddd', background: '#fafafa' }}>
          {graphData.nodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
              {loadStatus.profiles === 'done' ? 'No characters published kind:0 yet.' : 'Loading…'}
            </div>
          )}
          <Suspense fallback={<div style={{ padding: 32 }}>Loading graph…</div>}>
            <ForceGraph2D
              ref={graphRef}
              graphData={graphData}
              width={dimensions.width}
              height={dimensions.height}
              backgroundColor="rgba(0,0,0,0)"
              nodeCanvasObject={paintNode}
              nodePointerAreaPaint={(node, color, ctx) => {
                const r = 6 + Math.min(node.followCount, 8)
                ctx.fillStyle = color
                ctx.beginPath()
                ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
                ctx.fill()
              }}
              linkColor={() => 'rgba(0,0,0,0.18)'}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={0.85}
              onNodeHover={(n) => setHoverNode(n || null)}
              onNodeClick={(n) => setSelectedPk(selectedPk === n.id ? null : n.id)}
              cooldownTime={4000}
            />
          </Suspense>
          {hoverNode && hoverNode.id !== selectedPk && (
            <div style={{
              position: 'absolute', top: 8, left: 8,
              background: 'white', border: '1px solid #ddd', padding: 8, fontSize: 12,
              maxWidth: 280, pointerEvents: 'none',
            }}>
              <strong>{hoverNode.name}</strong>
              {hoverNode.about && <div style={{ marginTop: 4, opacity: 0.8 }}>{hoverNode.about}</div>}
              <div style={{ marginTop: 4, opacity: 0.6 }}>{hoverNode.followCount} following</div>
            </div>
          )}
        </div>

        <aside style={{ width: 320, flexShrink: 0, overflow: 'auto', borderLeft: '1px solid #ddd', paddingLeft: 16 }}>
          {!selectedPk && (
            <div style={{ fontSize: 13, opacity: 0.6 }}>
              Click a node to inspect a character.
            </div>
          )}
          {selectedPk && selectedProfile && (
            <div style={{ fontSize: 13 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
                {selectedProfile.picture && (
                  <img
                    src={selectedProfile.picture}
                    alt=""
                    style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', border: '1px solid #ddd' }}
                  />
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{selectedProfile.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>
                    <code>{shortPubkey(selectedPk)}</code>
                  </div>
                </div>
              </div>
              {selectedProfile.about && (
                <p style={{ marginTop: 0, marginBottom: 12 }}>{selectedProfile.about}</p>
              )}
              {selectedJumbleUrl && (
                <div style={{ marginBottom: 12 }}>
                  <a href={selectedJumbleUrl} target="_blank" rel="noreferrer">View on Jumble →</a>
                </div>
              )}
              <div style={{ marginBottom: 12 }}>
                <strong>npub:</strong>
                <code style={{ display: 'block', fontSize: 10, marginTop: 2, wordBreak: 'break-all', opacity: 0.7 }}>
                  {safeNpub(selectedPk)}
                </code>
              </div>
              {selectedFollows.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <strong>Following ({selectedFollows.length})</strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {selectedFollows.map((pk) => (
                      <button
                        key={pk}
                        type="button"
                        onClick={() => setSelectedPk(pk)}
                        style={{
                          fontSize: 11, padding: '2px 6px',
                          border: '1px solid #ccc', background: 'white', cursor: 'pointer',
                        }}
                      >
                        {profiles[pk].name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {selectedFollowedBy.length > 0 && (
                <div>
                  <strong>Followed by ({selectedFollowedBy.length})</strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {selectedFollowedBy.map((pk) => (
                      <button
                        key={pk}
                        type="button"
                        onClick={() => setSelectedPk(pk)}
                        style={{
                          fontSize: 11, padding: '2px 6px',
                          border: '1px solid #ccc', background: 'white', cursor: 'pointer',
                        }}
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

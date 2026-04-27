import { useMemo, useState } from 'react'

// 2D grid viewer over the Colyseus room state. Positions are the
// authoritative x/y from the server; drag-drop triggers real bridge
// calls, click-on-empty-tile moves the human's presence.

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase()
}

// Minimal type→glyph table mirroring agent-sandbox/pi-bridge/objects.js.
// Sync on every #245 type addition; promote to a /objects/types fetch
// when it grows past ~10 entries.
const OBJECT_GLYPHS = {
  chair: '🪑',
  bed: '🛏️',
  bookshelf: '📚',
  jukebox: '🎵',
  table: '🍽️',
  fridge: '🧊',
  // Fridge is unlocked at #245 slice 2; lives in the communal kitchen.
}
function objectGlyph(type) {
  return OBJECT_GLYPHS[type] || '◆'
}

// Compute wellbeing from a needs vector — mirrors wellbeingFromNeeds()
// in AgentProfile.jsx and computeMalaise() on the bridge.
const WELLBEING_BANDS_MAP = [
  { name: 'thriving',   min: 70 },
  { name: 'uneasy',     min: 50 },
  { name: 'distressed', min: 30 },
  { name: 'in_crisis',  min: 0  },
]
function wellbeingFromNeeds(needs) {
  // Note: this only reflects biological pressure (energy, social).
  // Slice 4 of #275 will switch the dot color to drive off the
  // moodlet-derived mood band, which is the audience-honest read.
  if (!needs) return null
  let min = 100
  for (const axis of ['energy', 'social']) {
    const v = typeof needs[axis] === 'number' ? needs[axis] : 100
    if (v < min) min = v
  }
  for (const b of WELLBEING_BANDS_MAP) if (min >= b.min) return b.name
  return 'in_crisis'
}


export default function RoomMap({
  width = 16,
  height = 12,
  characters = [],           // bridge /characters, with runtime + avatarUrl
  roomAgents = [],           // Colyseus presence array with x,y
  objects = [],              // bridge /objects — placed smart objects
  rooms = [],                // bridge /rooms — named regions on the grid
  adminPubkey = null,
  humanPubkey = null,
  onDropCharacter,           // (pubkey, x, y) -> spawn/move decision handled by caller
  onMoveSelf,                // (x, y) -> human move
  onSelectCharacter,         // (pubkey) -> open inspector drawer
}) {
  const [dragOver, setDragOver] = useState(null)

  // Room region tinting per type — apartments get owner-name labels;
  // hallways and communals are subtler. Each tile gets a class derived
  // from the room it falls into.
  const roomByCell = useMemo(() => {
    const cells = new Map()
    for (const r of rooms ?? []) {
      for (let yy = r.y; yy < r.y + r.h; yy++) {
        for (let xx = r.x; xx < r.x + r.w; xx++) {
          cells.set(`${xx},${yy}`, r)
        }
      }
    }
    return cells
  }, [rooms])

  // Lookup name → display string for each apartment owner so the
  // overlay label reads "Maya — 1A" instead of a 64-char npub.
  const ownerName = useMemo(() => {
    const m = new Map()
    for (const c of characters) if (c.pubkey) m.set(c.pubkey, c.name || c.pubkey.slice(0, 6))
    return m
  }, [characters])

  // Enrich presence rows with avatar/display info from characters list.
  // Presence is the source of truth for x/y; characters contributes visual.
  const byCell = useMemo(() => {
    const cells = new Map()
    const charByNpub = new Map()
    for (const c of characters) if (c.pubkey) charByNpub.set(c.pubkey, c)

    for (const a of roomAgents) {
      const c = charByNpub.get(a.npub)
      const kind =
        a.npub === humanPubkey ? 'human'
        : a.npub === adminPubkey ? 'admin'
        : c ? 'character'
        : 'presence'
      const rec = {
        npub: a.npub,
        name: a.name || c?.name,
        x: a.x,
        y: a.y,
        avatarUrl: c?.avatarUrl,
        running: !!c?.runtime?.running,
        thinking: !!c?.runtime?.thinking,
        // Derived wellbeing badge — only on character avatars since
        // admin/human/observer kinds don't carry needs.
        wellbeing: kind === 'character' ? wellbeingFromNeeds(c?.needs) : null,
        kind,
      }
      const key = `${a.x},${a.y}`
      const list = cells.get(key) ?? []
      list.push(rec)
      cells.set(key, list)
    }
    return cells
  }, [characters, roomAgents, adminPubkey, humanPubkey])

  function onCellDragOver(e, x, y) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver({ x, y })
  }
  function onCellDrop(e, x, y) {
    e.preventDefault()
    setDragOver(null)
    const pubkey = e.dataTransfer.getData('application/x-character-pubkey')
    if (!pubkey) return
    onDropCharacter?.(pubkey, x, y)
  }
  function onCellClick(x, y) {
    if (!onMoveSelf) return
    const occupants = byCell.get(`${x},${y}`) ?? []
    if (occupants.some((o) => o.kind !== 'human')) return // don't step on others
    onMoveSelf(x, y)
  }

  // Index objects by tile so the renderer can pick them up cheaply.
  const objectsByCell = useMemo(() => {
    const m = new Map()
    for (const o of objects ?? []) {
      const key = `${o.x},${o.y}`
      const list = m.get(key) ?? []
      list.push(o)
      m.set(key, list)
    }
    return m
  }, [objects])

  return (
    <div className="room-map-wrap">
      <div
        className="room-map"
        style={{
          gridTemplateColumns: `repeat(${width}, 1fr)`,
          gridTemplateRows: `repeat(${height}, 1fr)`,
        }}
      >
        {Array.from({ length: height }, (_, y) =>
          Array.from({ length: width }, (_, x) => {
            const occupants = byCell.get(`${x},${y}`) ?? []
            const tileObjects = objectsByCell.get(`${x},${y}`) ?? []
            const region = roomByCell.get(`${x},${y}`) ?? null
            const isDragOver = dragOver && dragOver.x === x && dragOver.y === y
            const roomClass = region ? ` room-region region-type-${region.type} region-${region.id}` : ''
            return (
              <div
                key={`${x}-${y}`}
                className={`room-tile${isDragOver ? ' drag-over' : ''}${occupants.length ? ' occupied' : ''}${roomClass}`}
                onDragOver={(e) => onCellDragOver(e, x, y)}
                onDragLeave={() => setDragOver((cur) => (cur?.x === x && cur?.y === y ? null : cur))}
                onDrop={(e) => onCellDrop(e, x, y)}
                onClick={() => onCellClick(x, y)}
                title={occupants.map((o) => `${o.name} (${o.x},${o.y})`).join(', ') || `(${x}, ${y})`}
              >
                {occupants.slice(0, 1).map((o) => {
                  const selectable = o.kind === 'character' && onSelectCharacter
                  // Characters on the board are draggable — drop on a
                  // tile fires the same onDropCharacter the sidebar cards
                  // do (which routes to the bridge's /agents/:id/move).
                  const draggable = o.kind === 'character' && !!onDropCharacter
                  // Inline handler reused so the inner img can also
                  // initiate a drag — without this, browsers that take
                  // the inner image as the drag target see draggable=false
                  // and never start the drag.
                  const startDrag = (e) => {
                    e.dataTransfer.setData('application/x-character-pubkey', o.npub)
                    e.dataTransfer.setData('text/plain', o.npub)
                    e.dataTransfer.effectAllowed = 'copyMove'
                  }
                  return (
                    <div
                      key={o.npub}
                      className={`room-tile-avatar kind-${o.kind}${o.thinking ? ' thinking' : ''}${o.running ? ' running' : ''}${selectable ? ' selectable' : ''}${draggable ? ' draggable' : ''}`}
                      draggable={draggable || undefined}
                      onDragStart={draggable ? startDrag : undefined}
                      onClick={selectable ? (e) => { e.stopPropagation(); onSelectCharacter(o.npub) } : undefined}
                      title={selectable ? `Drag to move · click to inspect ${o.name}` : undefined}
                    >
                      {o.avatarUrl ? (
                        <img
                          src={o.avatarUrl}
                          alt={o.name}
                          draggable={draggable || undefined}
                          onDragStart={draggable ? startDrag : undefined}
                        />
                      ) : (
                        <span>{initial(o.name)}</span>
                      )}
                      {o.wellbeing && (
                        <span
                          className={`room-tile-wellbeing wellbeing-${o.wellbeing}`}
                          title={`wellbeing: ${o.wellbeing.replace('_', ' ')}`}
                        />
                      )}
                    </div>
                  )
                })}
                {/* Object glyph layer — sits BEHIND the avatar
                    (lower z-index in CSS) so a character on the
                    same tile reads first. Empty tiles show the
                    object glyph centered. */}
                {tileObjects.length > 0 && occupants.length === 0 && (
                  <span
                    className="room-tile-object"
                    title={tileObjects.map((o) => o.type).join(', ')}
                  >
                    {objectGlyph(tileObjects[0].type)}
                  </span>
                )}
                {tileObjects.length > 0 && occupants.length > 0 && (
                  <span
                    className="room-tile-object-corner"
                    title={tileObjects.map((o) => o.type).join(', ')}
                  >
                    {objectGlyph(tileObjects[0].type)}
                  </span>
                )}
                {occupants.length > 1 && (
                  <span className="room-tile-badge">+{occupants.length - 1}</span>
                )}
              </div>
            )
          }),
        )}
        {/* Room labels — one floating chip per region, anchored to
            the room's top-left tile. Sits over the grid via absolute
            positioning, so it doesn't disturb the existing tile flow. */}
        {(rooms ?? []).map((r) => {
          const owner = r.owner_pubkey ? ownerName.get(r.owner_pubkey) : null
          const label = owner ? `${owner} — ${r.id.replace(/^apt-/, '')}` : r.name
          return (
            <span
              key={`label-${r.id}`}
              className={`room-region-label region-type-${r.type}`}
              style={{
                gridColumnStart: r.x + 1,
                gridColumnEnd: r.x + r.w + 1,
                gridRowStart: r.y + 1,
                gridRowEnd: r.y + 1 + 1,
              }}
              title={`${r.name}${owner ? ` · owned by ${owner}` : ''}`}
            >
              {label}
            </span>
          )
        })}
      </div>
      <p className="room-map-caption">
        {width}×{height} · drag a card or avatar onto a tile to spawn / move · click an empty tile to move yourself
      </p>
    </div>
  )
}

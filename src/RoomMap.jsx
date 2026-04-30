import { useMemo, useState } from 'react'

// 2D grid viewer over the Colyseus room state. Each tile is placed
// with explicit gridColumn/gridRow (CSS lines are 1-indexed) so a
// tile at data (x, y) lands at column x+1, row y+1 — no auto-flow.

const OBJECT_GLYPHS = {
  chair: '🪑',
  bed: '🛏️',
  bookshelf: '📚',
  jukebox: '🎵',
  table: '🍽️',
  fridge: '🧊',
}
const objectGlyph = (type) => OBJECT_GLYPHS[type] || '◆'

const WELLBEING_BANDS = [
  { name: 'thriving',   min: 70 },
  { name: 'uneasy',     min: 50 },
  { name: 'distressed', min: 30 },
  { name: 'in_crisis',  min: 0  },
]
function wellbeingFromNeeds(needs) {
  if (!needs) return null
  let min = 100
  for (const axis of ['energy', 'social']) {
    const v = typeof needs[axis] === 'number' ? needs[axis] : 100
    if (v < min) min = v
  }
  for (const b of WELLBEING_BANDS) if (min >= b.min) return b.name
  return 'in_crisis'
}

const initial = (name) => (name || '?').trim().charAt(0).toUpperCase()

export default function RoomMap({
  width = 12,
  height = 16,
  characters = [],
  roomAgents = [],
  objects = [],
  rooms = [],
  adminPubkey = null,
  humanPubkey = null,
  onDropCharacter,
  onMoveSelf,
  onSelectCharacter,
  showGrid = true,     // gap + border between tiles
  showLabels = true,   // floating room-name chips
  showCaption = true,
  selectedRoomId = null,
  onSelectRoom,        // (roomId | null) -> select a room by tap
  onActivateRoom,      // (roomId) -> double-tap activate (e.g. open in 3D)
}) {
  const [dragOver, setDragOver] = useState(null)

  // Tile (x,y) → room object. Doors checked first so they win when
  // their rect overlaps a parent room.
  const roomByCell = useMemo(() => {
    const cells = new Map()
    const ordered = [...(rooms ?? [])].sort((a, b) =>
      (a.type === 'door' ? 0 : 1) - (b.type === 'door' ? 0 : 1),
    )
    for (const r of ordered) {
      for (let yy = r.y; yy < r.y + r.h; yy++) {
        for (let xx = r.x; xx < r.x + r.w; xx++) {
          const k = `${xx},${yy}`
          if (!cells.has(k)) cells.set(k, r)
        }
      }
    }
    return cells
  }, [rooms])

  const occupantsByCell = useMemo(() => {
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
        wellbeing: kind === 'character' ? wellbeingFromNeeds(c?.needs) : null,
        kind,
      }
      const k = `${a.x},${a.y}`
      const list = cells.get(k) ?? []
      list.push(rec)
      cells.set(k, list)
    }
    return cells
  }, [characters, roomAgents, adminPubkey, humanPubkey])

  const objectsByCell = useMemo(() => {
    const cells = new Map()
    for (const o of objects ?? []) {
      const k = `${o.x},${o.y}`
      const list = cells.get(k) ?? []
      list.push(o)
      cells.set(k, list)
    }
    return cells
  }, [objects])

  const tiles = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const key = `${x},${y}`
      const region = roomByCell.get(key) ?? null
      const occupants = occupantsByCell.get(key) ?? []
      const tileObjects = objectsByCell.get(key) ?? []
      const isWall = !region
      const isDragOver = dragOver?.x === x && dragOver?.y === y

      const cls = [
        'room-tile',
        isWall ? 'is-wall' : `room-region region-type-${region.type}`,
        occupants.length ? 'occupied' : '',
        isDragOver ? 'drag-over' : '',
      ].filter(Boolean).join(' ')

      const handleDragOver = isWall ? undefined : (e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragOver({ x, y })
      }
      const handleDragLeave = () => {
        setDragOver((cur) => (cur?.x === x && cur?.y === y ? null : cur))
      }
      const handleDrop = isWall ? undefined : (e) => {
        e.preventDefault()
        setDragOver(null)
        const pubkey = e.dataTransfer.getData('application/x-character-pubkey')
        if (pubkey) onDropCharacter?.(pubkey, x, y)
      }
      // Selection mode (onSelectRoom provided) takes precedence over
      // the move-self behavior. Tap-twice flow tuned for mobile:
      //   1st tap on a room → select it
      //   2nd tap on the same room → activate (e.g. open in 3D)
      // (mobile browsers don't fire dblclick reliably, so we model
      // activation as a follow-up tap on the selected target.)
      const handleClick = isWall ? undefined : () => {
        if (onSelectRoom) {
          if (region.type === 'door') return
          if (region.id === selectedRoomId && onActivateRoom) {
            onActivateRoom(region.id)
          } else {
            onSelectRoom(region.id)
          }
          return
        }
        if (!onMoveSelf) return
        if (occupants.some((o) => o.kind !== 'human')) return
        onMoveSelf(x, y)
      }

      const tileStyle = { gridColumn: x + 1, gridRow: y + 1 }
      if (region?.color && region.type !== 'door') tileStyle.background = region.color

      tiles.push(
        <div
          key={key}
          className={cls}
          style={tileStyle}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleClick}
          title={occupants.map((o) => `${o.name} (${o.x},${o.y})`).join(', ') || `(${x}, ${y})`}
        >
          {occupants.slice(0, 1).map((o) => {
            const selectable = o.kind === 'character' && !!onSelectCharacter
            const draggable = o.kind === 'character' && !!onDropCharacter
            const startDrag = (e) => {
              e.dataTransfer.setData('application/x-character-pubkey', o.npub)
              e.dataTransfer.setData('text/plain', o.npub)
              e.dataTransfer.effectAllowed = 'copyMove'
            }
            return (
              <div
                key={o.npub}
                className={[
                  'room-tile-avatar',
                  `kind-${o.kind}`,
                  o.thinking ? 'thinking' : '',
                  o.running ? 'running' : '',
                  selectable ? 'selectable' : '',
                  draggable ? 'draggable' : '',
                ].filter(Boolean).join(' ')}
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
          {tileObjects.length > 0 && occupants.length === 0 && (
            <span className="room-tile-object" title={tileObjects.map((o) => o.type).join(', ')}>
              {objectGlyph(tileObjects[0].type)}
            </span>
          )}
          {tileObjects.length > 0 && occupants.length > 0 && (
            <span className="room-tile-object-corner" title={tileObjects.map((o) => o.type).join(', ')}>
              {objectGlyph(tileObjects[0].type)}
            </span>
          )}
          {occupants.length > 1 && (
            <span className="room-tile-badge">+{occupants.length - 1}</span>
          )}
        </div>,
      )
    }
  }

  const selectedRoom = (rooms ?? []).find(
    (r) => r.id === selectedRoomId && r.type !== 'door',
  )
  const selectionOverlay = selectedRoom ? (
    <div
      className="room-selection-overlay"
      style={{
        gridColumnStart: selectedRoom.x + 1,
        gridColumnEnd: selectedRoom.x + selectedRoom.w + 1,
        gridRowStart: selectedRoom.y + 1,
        gridRowEnd: selectedRoom.y + selectedRoom.h + 1,
      }}
    />
  ) : null

  const labels = showLabels
    ? (rooms ?? [])
        .filter((r) => r.type !== 'door' && r.name)
        .map((r) => (
          <span
            key={`label-${r.id}`}
            className={`room-region-label region-type-${r.type}`}
            style={{
              gridColumnStart: r.x + 1,
              gridColumnEnd: r.x + r.w + 1,
              gridRowStart: r.y + 1,
              gridRowEnd: r.y + 2,
            }}
            title={r.name}
          >
            {r.name}
          </span>
        ))
    : null

  return (
    <div className="room-map-wrap">
      <div
        className={`room-map${showGrid ? '' : ' no-grid'}`}
        style={{
          gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${height}, minmax(0, 1fr))`,
          aspectRatio: `${width} / ${height}`,
          '--map-w': width,
          '--map-h': height,
        }}
      >
        {tiles}
        {selectionOverlay}
        {labels}
      </div>
      {showCaption && (
        <p className="room-map-caption">
          {width}×{height} · drag a card or avatar onto a tile to spawn / move · click an empty tile to move yourself
        </p>
      )}
    </div>
  )
}

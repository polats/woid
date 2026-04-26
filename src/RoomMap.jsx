import { useMemo, useState } from 'react'

// 2D grid viewer over the Colyseus room state. Positions are the
// authoritative x/y from the server; drag-drop triggers real bridge
// calls, click-on-empty-tile moves the human's presence.

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase()
}

export default function RoomMap({
  width = 16,
  height = 12,
  characters = [],           // bridge /characters, with runtime + avatarUrl
  roomAgents = [],           // Colyseus presence array with x,y
  adminPubkey = null,
  humanPubkey = null,
  onDropCharacter,           // (pubkey, x, y) -> spawn/move decision handled by caller
  onMoveSelf,                // (x, y) -> human move
  onSelectCharacter,         // (pubkey) -> open inspector drawer
}) {
  const [dragOver, setDragOver] = useState(null)

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
            const isDragOver = dragOver && dragOver.x === x && dragOver.y === y
            return (
              <div
                key={`${x}-${y}`}
                className={`room-tile${isDragOver ? ' drag-over' : ''}${occupants.length ? ' occupied' : ''}`}
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
                    </div>
                  )
                })}
                {occupants.length > 1 && (
                  <span className="room-tile-badge">+{occupants.length - 1}</span>
                )}
              </div>
            )
          }),
        )}
      </div>
      <p className="room-map-caption">
        {width}×{height} · drag a card or avatar onto a tile to spawn / move · click an empty tile to move yourself
      </p>
    </div>
  )
}

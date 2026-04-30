import RoomMap from '../RoomMap.jsx'

/**
 * Read-only map pane on the Game phone surface. Receives world data
 * from the parent so Stage3D and MapView share a single fetch and
 * a single selection state. Tap a tile to select that room.
 */
export default function MapView({
  rooms = [],
  grid = null,
  objects = [],
  characters = [],
  roomAgents = [],
  selectedRoomId = null,
  onSelectRoom,
  onActivateRoom,
}) {
  if (!grid) {
    return <div className="game-placeholder"><span>loading map…</span></div>
  }

  return (
    <div className="game-map-view">
      <RoomMap
        width={grid.width}
        height={grid.height}
        rooms={rooms}
        objects={objects}
        characters={characters}
        roomAgents={roomAgents}
        showGrid={false}
        showCaption={false}
        selectedRoomId={selectedRoomId}
        onSelectRoom={onSelectRoom}
        onActivateRoom={onActivateRoom}
      />
    </div>
  )
}

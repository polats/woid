import { useEffect, useMemo, useRef, useState } from 'react'
import config from '../config.js'
import Stage3D from './Stage3D.jsx'
import MapView from './MapView.jsx'
import SpellPicker from './SpellPicker.jsx'
import { useSandboxRoom } from '../hooks/useSandboxRoom.js'

/**
 * Game view — mock mobile phone surface. Owns shared world state
 * (rooms, grid, objects, selected room) so the Stage and Map tabs
 * stay in sync without each fetching independently.
 *
 * All tab panes stay mounted so the Stage3D WebGL context survives
 * tab switches (mobile browsers cap WebGL contexts).
 */

const TABS = [
  { id: 'stage', label: 'Stage', glyph: '◆' },
  { id: 'chat', label: 'Chat', glyph: '◌' },
  { id: 'map', label: 'Map', glyph: '◇' },
  { id: 'menu', label: 'Menu', glyph: '☰' },
]

function Placeholder({ label }) {
  return (
    <div className="game-placeholder">
      <span>{label}</span>
    </div>
  )
}

export function PhoneScreen() {
  const cfg = config.agentSandbox || {}
  const [tab, setTab] = useState('map')
  const [rooms, setRooms] = useState([])
  const [grid, setGrid] = useState(null)
  const [objects, setObjects] = useState([])
  const [characters, setCharacters] = useState([])
  // Spell picker state — { npub, name, x, y } when an agent is tapped.
  const [picker, setPicker] = useState(null)
  const stageRef = useRef(null)
  // Start in the lobby — gives a sensible "you've just walked in"
  // default for the stage view instead of the unbiased full scene.
  const [selectedRoomId, setSelectedRoomId] = useState('lobby')

  // Live presence — colyseus state. Agents come from here (x/y in
  // realtime); avatars/names are enriched from /characters below.
  const { state: roomState } = useSandboxRoom({
    url: cfg.roomServerUrl,
    roomName: cfg.defaultRoom || 'sandbox',
  })

  useEffect(() => {
    if (!cfg.bridgeUrl) return
    let cancelled = false
    const refresh = async () => {
      try {
        const [rms, objs, chars] = await Promise.all([
          fetch(`${cfg.bridgeUrl}/rooms`).then((r) => r.ok ? r.json() : null),
          fetch(`${cfg.bridgeUrl}/objects`).then((r) => r.ok ? r.json() : { objects: [] }),
          fetch(`${cfg.bridgeUrl}/characters`).then((r) => r.ok ? r.json() : { characters: [] }),
        ])
        if (cancelled) return
        if (rms?.rooms) setRooms(rms.rooms)
        if (rms?.grid) setGrid(rms.grid)
        if (objs?.objects) setObjects(objs.objects)
        if (chars?.characters) setCharacters(chars.characters)
      } catch { /* transient */ }
    }
    refresh()
    const t = setInterval(refresh, 5000)
    return () => { cancelled = true; clearInterval(t) }
  }, [cfg.bridgeUrl])

  const selectedRoom = useMemo(
    () => rooms.find((r) => r.id === selectedRoomId) ?? null,
    [rooms, selectedRoomId],
  )

  // Agents currently inside the selected room — colyseus presence
  // gives us realtime x/y; characters supplies the avatar URL.
  // Stage3D renders one avatar.glb per entry plus a profile-pic
  // badge above the head.
  const agentsInRoom = useMemo(() => {
    if (!selectedRoom) return []
    const charByNpub = new Map()
    for (const c of characters) if (c.pubkey) charByNpub.set(c.pubkey, c)
    const xMin = selectedRoom.x
    const xMax = selectedRoom.x + selectedRoom.w
    const yMin = selectedRoom.y
    const yMax = selectedRoom.y + selectedRoom.h
    return (roomState?.agents ?? [])
      .filter((a) => a.x >= xMin && a.x < xMax && a.y >= yMin && a.y < yMax)
      .map((a) => {
        const c = charByNpub.get(a.npub)
        return {
          npub: a.npub,
          name: a.name || c?.name || '?',
          avatarUrl: c?.avatarUrl || null,
          // If the character has a Trellis-generated GLB on disk, the
          // bridge serves it from this path. Stage3D HEADs the URL
          // before loading and falls back to the generic template if
          // missing — so passing it unconditionally is safe.
          modelUrl: cfg.bridgeUrl && a.npub
            ? `${cfg.bridgeUrl}/characters/${a.npub}/model`
            : null,
        }
      })
  }, [selectedRoom, roomState?.agents, characters])

  return (
    <div className="game-phone-screen">
      <div className="game-status-bar">
        <span>9:41</span>
        <span>●●● ▮▮</span>
      </div>
      <div className="game-screen-body">
        <div className="game-tab-pane" hidden={tab !== 'stage'}>
          <div className="game-stage-pane">
            <div className="game-stage-3d-wrap">
              <Stage3D
                ref={stageRef}
                floorColor={selectedRoom?.color ?? null}
                visibleObjects={selectedRoom?.sceneObjects ?? null}
                agents={agentsInRoom}
                onAgentTap={(npub, screenPos) => {
                  const a = agentsInRoom.find((x) => x.npub === npub)
                  setPicker({ npub, name: a?.name ?? '?', x: screenPos.x, y: screenPos.y })
                }}
              />
              {selectedRoom && (
                <div
                  // Key on room id so React remounts the element when
                  // the selection changes — that retriggers the
                  // slide-in animation each time.
                  key={selectedRoom.id}
                  className="game-stage-room-chip"
                  style={{ background: selectedRoom.color }}
                >
                  {selectedRoom.name}
                </div>
              )}
              {picker && (
                <SpellPicker
                  npub={picker.npub}
                  agentName={picker.name}
                  screenPos={{ x: picker.x, y: picker.y }}
                  onPick={(spell) => {
                    stageRef.current?.castOnAgent(picker.npub, spell.schema)
                    setPicker(null)
                  }}
                  onCancel={() => setPicker(null)}
                />
              )}
            </div>
          </div>
        </div>
        <div className="game-tab-pane" hidden={tab !== 'map'}>
          <MapView
            rooms={rooms}
            grid={grid}
            objects={objects}
            characters={characters}
            roomAgents={roomState?.agents ?? []}
            selectedRoomId={selectedRoomId}
            onSelectRoom={setSelectedRoomId}
            onActivateRoom={(id) => { setSelectedRoomId(id); setTab('stage') }}
          />
        </div>
        <div className="game-tab-pane" hidden={tab !== 'chat'}><Placeholder label="chat" /></div>
        <div className="game-tab-pane" hidden={tab !== 'menu'}><Placeholder label="menu" /></div>
      </div>
      <nav className="game-tab-bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`game-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="game-tab-glyph">{t.glyph}</span>
            <span className="game-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

export default function Game() {
  return (
    <div className="game-view">
      <div className="game-phone-frame">
        <div className="game-phone-notch" />
        <PhoneScreen />
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import config from './config.js'
import { useSandboxRoom } from './hooks/useSandboxRoom.js'
import { useBridgeModels } from './hooks/useBridgeModels.js'
import { useBridgeCharacters } from './hooks/useBridgeCharacters.js'
import AgentDrawer from './AgentDrawer.jsx'
import RoomMap from './RoomMap.jsx'
import Recap from './Recap.jsx'
import Storyteller from './Storyteller.jsx'
import SimClock from './SimClock.jsx'
import SandboxCards from './components/SandboxCards.jsx'
import { useWorldDrop } from './hooks/useWorldDrop.js'
import { spawnOrMoveBridgeAgent } from './lib/bridgeSpawn.js'

const cfg = config.agentSandbox || {}

export default function Sandbox() {
  // Bridge roster comes from the shared hook so the overlay and the
  // sandbox see the same list with the same poll cadence.
  const { characters, refresh: refreshCharacters } = useBridgeCharacters()
  const [objects, setObjects] = useState([])
  const [rooms, setRooms] = useState([])
  const [grid, setGrid] = useState(null) // { width, height } from /rooms
  const [stageView, setStageView] = useState('room')
  const [adminInfo, setAdminInfo] = useState(null)
  const [chatDraft, setChatDraft] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState(null)
  const [inspectedId, setInspectedId] = useState(null)
  const [drawerTab, setDrawerTab] = useState('context')
  const [humanInfo, setHumanInfo] = useState(null)
  const profileDirtyRef = useRef(false)
  const chatlogRef = useRef(null)

  function safelySetInspectedId(next, tab) {
    if (
      next !== inspectedId &&
      profileDirtyRef.current &&
      !window.confirm('You have unsaved profile changes. Discard and switch character?')
    ) {
      return
    }
    profileDirtyRef.current = false
    setInspectedId(next)
    if (tab) setDrawerTab(tab)
  }

  const { models } = useBridgeModels(cfg.bridgeUrl)
  const { status: roomStatus, state: roomState, error: roomError } = useSandboxRoom({
    url: cfg.roomServerUrl,
    roomName: cfg.defaultRoom || 'sandbox',
  })

  const refreshWorld = useCallback(async () => {
    if (!cfg.bridgeUrl) return
    try {
      const [objs, rms] = await Promise.all([
        fetch(`${cfg.bridgeUrl}/objects`).then((r) => (r.ok ? r.json() : { objects: [] })),
        fetch(`${cfg.bridgeUrl}/rooms`).then((r) => (r.ok ? r.json() : { rooms: [] })),
      ])
      setObjects(objs.objects || [])
      setRooms(rms.rooms || [])
      if (rms.grid) setGrid(rms.grid)
    } catch { /* transient */ }
  }, [])

  useEffect(() => {
    refreshWorld()
    const t = setInterval(refreshWorld, 3000)
    return () => clearInterval(t)
  }, [refreshWorld])

  useEffect(() => {
    if (!cfg.bridgeUrl) return
    fetch(`${cfg.bridgeUrl}/admin`).then((r) => r.json()).then(setAdminInfo).catch(() => {})
    fetch(`${cfg.bridgeUrl}/human`).then((r) => r.json()).then(setHumanInfo).catch(() => {})
  }, [])

  useEffect(() => {
    const el = chatlogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [roomState.messages.length])

  async function sendChat(e) {
    e?.preventDefault?.()
    const text = chatDraft.trim()
    if (!text || chatSending) return
    setChatSending(true)
    setChatError(null)
    try {
      const r = await fetch(`${cfg.bridgeUrl}/human/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, roomName: cfg.defaultRoom || 'sandbox' }),
      })
      if (!r.ok) throw new Error(await r.text())
      setChatDraft('')
    } catch (err) {
      setChatError(err.message || String(err))
    } finally {
      setChatSending(false)
    }
  }

  // Drop on the Sims map — bridge driver + toast envelope come from
  // the harness; this view just supplies the post-spawn hook to open
  // the inspector and refresh the roster.
  const onDropCharacter = useWorldDrop({
    world: 'Sims',
    spawn: async (character, target) => {
      const r = await spawnOrMoveBridgeAgent({
        bridgeUrl: cfg.bridgeUrl,
        character, target, models,
        roomName: cfg.defaultRoom || 'sandbox',
      })
      if (!r.moved) setInspectedId(r.agentId)
      await refreshCharacters()
      return { toast: r.moved ? `${character.name} → (${r.x}, ${r.y})` : `${character.name} joined Sims` }
    },
  })

  async function onMoveSelf(x, y) {
    try {
      await fetch(`${cfg.bridgeUrl}/human/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, roomName: cfg.defaultRoom || 'sandbox' }),
      })
    } catch {}
  }

  const inspectedCharacter = inspectedId
    ? characters.find((c) => c.runtime?.agentId === inspectedId || c.pubkey === inspectedId)
    : null
  const inspectedAgent = inspectedCharacter
    ? {
        agentId: inspectedCharacter.runtime?.agentId ?? null,
        name: inspectedCharacter.name,
        npub: inspectedCharacter.pubkey,
        model: inspectedCharacter.runtime?.model ?? inspectedCharacter.model,
        running: inspectedCharacter.runtime?.running,
      }
    : inspectedId
    ? { agentId: inspectedId, name: '—', npub: null, model: null, running: false }
    : null

  return (
    <div className="sandbox3">
      <SandboxCards
        characters={characters}
        onRefresh={refreshCharacters}
        inspectedId={inspectedId}
        onInspect={safelySetInspectedId}
      />

      <section className="sandbox3-stage">
        <header>
          <nav className="sandbox3-stage-tabs" role="tablist" aria-label="stage view">
            <button
              type="button"
              role="tab"
              aria-selected={stageView === 'room'}
              className={`sandbox3-stage-tab${stageView === 'room' ? ' active' : ''}`}
              onClick={() => setStageView('room')}
              title="Room — the live map"
            >
              Room
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={stageView === 'recap'}
              className={`sandbox3-stage-tab${stageView === 'recap' ? ' active' : ''}`}
              onClick={() => setStageView('recap')}
              title="Recap — daily session summary"
            >
              Recap
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={stageView === 'storyteller'}
              className={`sandbox3-stage-tab${stageView === 'storyteller' ? ' active' : ''}`}
              onClick={() => setStageView('storyteller')}
              title="Storyteller — director state, card pool, force fires"
            >
              Storyteller
            </button>
          </nav>
          <div className="sandbox3-stage-meta">
            <SimClock />
            <small className={`status status-${roomStatus}`}>{roomStatus}</small>
          </div>
          {roomError && <p className="agent-sandbox-error">{roomError}</p>}
        </header>

        <div className={`sandbox3-map-frame${stageView !== 'room' ? ' showing-recap' : ''}`}>
          {stageView === 'recap' ? (
            <div className="sandbox3-recap-pane">
              <Recap />
            </div>
          ) : stageView === 'storyteller' ? (
            <div className="sandbox3-recap-pane">
              <Storyteller
                characters={characters}
                onInspect={(pubkey) => {
                  const c = characters.find((x) => x.pubkey === pubkey)
                  safelySetInspectedId(
                    c?.runtime?.agentId || pubkey,
                    c?.runtime?.agentId ? 'context' : 'profile',
                  )
                }}
              />
            </div>
          ) : (
            <RoomMap
              objects={objects}
              rooms={rooms}
              width={grid?.width ?? roomState.width}
              height={grid?.height ?? roomState.height}
              characters={characters}
              roomAgents={roomState.agents}
              adminPubkey={adminInfo?.pubkey}
              humanPubkey={humanInfo?.pubkey}
              onDropCharacter={onDropCharacter}
              onMoveSelf={onMoveSelf}
              onSelectCharacter={(pubkey) => {
                const c = characters.find((x) => x.pubkey === pubkey)
                safelySetInspectedId(
                  c?.runtime?.agentId || pubkey,
                  c?.runtime?.agentId ? 'context' : 'profile',
                )
              }}
            />
          )}
        </div>

        <div className="sandbox3-chatlog" ref={chatlogRef}>
          <ul className="agent-sandbox-messages">
            {roomState.messages.slice(-8).map((m, i) => (
              <li key={m.ts + i}>
                <strong>{m.from}:</strong> {m.text}
              </li>
            ))}
            {roomState.messages.length === 0 && <li className="muted">— no room chat yet —</li>}
          </ul>
        </div>

        <form className="sandbox2-chat" onSubmit={sendChat}>
          <input
            type="text"
            value={chatDraft}
            onChange={(e) => setChatDraft(e.target.value)}
            placeholder="Say something to the room…"
            disabled={chatSending}
            maxLength={1000}
          />
          <button type="submit" disabled={chatSending || !chatDraft.trim()}>
            {chatSending ? 'Sending…' : 'Send'}
          </button>
          {chatError && <span className="sandbox2-chat-error">{chatError}</span>}
        </form>
      </section>

      {inspectedId && (
        <AgentDrawer
          bridgeUrl={cfg.bridgeUrl}
          character={inspectedCharacter}
          agent={inspectedAgent}
          initialTab={drawerTab}
          onDirtyChange={(d) => { profileDirtyRef.current = d }}
          onClose={() => { profileDirtyRef.current = false; setInspectedId(null) }}
          onUpdated={() => refreshCharacters()}
          onDeleted={() => { setInspectedId(null); refreshCharacters() }}
        />
      )}
    </div>
  )
}

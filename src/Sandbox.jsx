import { useCallback, useEffect, useRef, useState } from 'react'
import config from '../woid.config.json'
import { useSandboxRoom } from './hooks/useSandboxRoom.js'
import { useSandboxSettings } from './hooks/useSandboxSettings.js'
import { useBridgeModels } from './hooks/useBridgeModels.js'
import AgentInspector from './AgentInspector.jsx'
import AgentProfile from './AgentProfile.jsx'
import RoomMap from './RoomMap.jsx'
import SandboxSettings from './SandboxSettings.jsx'

const cfg = config.agentSandbox || {}

export default function Sandbox() {
  const [characters, setCharacters] = useState([])
  const [adminInfo, setAdminInfo] = useState(null)
  const [chatDraft, setChatDraft] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState(null)
  const [profilePubkey, setProfilePubkey] = useState(null)
  const [inspectedId, setInspectedId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [spawnError, setSpawnError] = useState(null)
  const [humanInfo, setHumanInfo] = useState(null)
  const [dropToast, setDropToast] = useState(null)
  const chatlogRef = useRef(null)
  const { settings, update: updateSettings } = useSandboxSettings()
  const { models } = useBridgeModels(cfg.bridgeUrl)

  const { status: roomStatus, state: roomState, error: roomError } = useSandboxRoom({
    url: cfg.roomServerUrl,
    roomName: cfg.defaultRoom || 'sandbox',
  })

  const refresh = useCallback(async () => {
    if (!cfg.bridgeUrl) return
    try {
      const j = await fetch(`${cfg.bridgeUrl}/characters`).then((r) => r.json())
      setCharacters(j.characters || [])
    } catch {
      /* transient fetch errors are fine */
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (!cfg.bridgeUrl) return
    fetch(`${cfg.bridgeUrl}/admin`).then((r) => r.json()).then(setAdminInfo).catch(() => {})
    fetch(`${cfg.bridgeUrl}/human`).then((r) => r.json()).then(setHumanInfo).catch(() => {})
  }, [])

  // Keep the chat log scrolled to the newest message.
  useEffect(() => {
    const el = chatlogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [roomState.messages.length])

  async function newCharacter() {
    setSpawnError(null)
    try {
      const r = await fetch(`${cfg.bridgeUrl}/characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!r.ok) throw new Error(await r.text())
      const c = await r.json()
      await refresh()
      setProfilePubkey(c.pubkey)
    } catch (err) {
      setSpawnError(err.message || String(err))
    }
  }

  // Pick a coherent (provider, model) pair for a spawn. Priority:
  //   1. Sidebar Settings — if user has selected a provider, that wins.
  //      This is the *recent explicit* expression of intent; per-character
  //      model in AgentProfile is the fallback, not the override.
  //   2. Per-character c.model — used only if Settings has no provider
  //      selected (i.e. user hasn't touched Settings yet).
  //   3. Nothing — let pi-bridge use PI_MODEL / PI_DEFAULT_PROVIDER.
  function spawnBody(c, extra = {}) {
    let model, provider
    if (settings.provider) {
      const forProvider = models.filter((m) => m.provider === settings.provider)
      const hit = forProvider.find((m) => m.id === settings.model) ?? forProvider[0]
      if (hit) { model = hit.id; provider = hit.provider }
    }
    if (!model && c.model) {
      const hit = models.find((m) => m.id === c.model)
      if (hit) { model = hit.id; provider = hit.provider }
      else { model = c.model } // unknown id — let server fall through
    }
    return {
      pubkey: c.pubkey,
      roomName: cfg.defaultRoom || 'sandbox',
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...extra,
    }
  }

  async function spawn(c) {
    if (c.runtime) { setInspectedId(c.runtime.agentId); return }
    setCreating(true)
    setSpawnError(null)
    try {
      const r = await fetch(`${cfg.bridgeUrl}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spawnBody(c)),
      })
      if (!r.ok) throw new Error(await r.text())
      const result = await r.json()
      await refresh()
      setInspectedId(result.agentId)
    } catch (err) {
      setSpawnError(err.message || String(err))
    } finally {
      setCreating(false)
    }
  }

  async function stopRuntime(agentId) {
    try {
      await fetch(`${cfg.bridgeUrl}/agents/${agentId}`, { method: 'DELETE' })
      await refresh()
    } catch {}
  }

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

  // Drop a card onto a tile: spawn at coord if no runtime, otherwise
  // move the existing runtime to the target tile.
  async function onDropCharacter(pubkey, x, y) {
    const c = characters.find((ch) => ch.pubkey === pubkey)
    if (!c) return
    setSpawnError(null)
    try {
      if (c.runtime?.running) {
        const r = await fetch(`${cfg.bridgeUrl}/agents/${c.runtime.agentId}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x, y }),
        })
        if (!r.ok) throw new Error(await r.text())
        setDropToast({ text: `${c.name} → (${x}, ${y})`, at: Date.now() })
      } else {
        setCreating(true)
        try {
          const r = await fetch(`${cfg.bridgeUrl}/agents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(spawnBody(c, { x, y })),
          })
          if (!r.ok) throw new Error(await r.text())
          const result = await r.json()
          setInspectedId(result.agentId)
          setDropToast({ text: `spawned ${c.name} at (${x}, ${y})`, at: Date.now() })
        } finally { setCreating(false) }
      }
      await refresh()
    } catch (err) {
      setSpawnError(err.message || String(err))
    }
    setTimeout(() => setDropToast((t) => (t && Date.now() - t.at >= 2500 ? null : t)), 2700)
  }

  async function onMoveSelf(x, y) {
    try {
      await fetch(`${cfg.bridgeUrl}/human/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, roomName: cfg.defaultRoom || 'sandbox' }),
      })
    } catch {}
  }

  const inspectedCharacter = characters.find((c) => c.runtime?.agentId === inspectedId)
  const inspectedAgent = inspectedCharacter
    ? {
        agentId: inspectedCharacter.runtime.agentId,
        name: inspectedCharacter.name,
        npub: inspectedCharacter.pubkey,
        model: inspectedCharacter.runtime.model ?? inspectedCharacter.model,
        running: inspectedCharacter.runtime.running,
      }
    : null

  return (
    <div className="sandbox3">
      <aside className="sandbox3-cards">
        <SandboxSettings
          bridgeUrl={cfg.bridgeUrl}
          settings={settings}
          onChange={updateSettings}
        />
        <header>
          <h2>Agents</h2>
          <button onClick={newCharacter} title="Create a new character with a random name + keypair">
            + New
          </button>
        </header>
        {spawnError && <p className="agent-sandbox-error">{spawnError}</p>}
        {characters.length === 0 ? (
          <p className="muted">No agents yet. Click + New to mint one.</p>
        ) : (
          <ul className="sandbox3-card-list">
            {characters.map((c) => {
              const runtime = c.runtime?.running ? c.runtime : null
              const thinking = !!runtime?.thinking
              const initial = (c.name || '?').trim().charAt(0).toUpperCase()
              return (
                <li
                  key={c.pubkey}
                  className={`sandbox3-card${runtime ? ' running' : ''}${thinking ? ' thinking' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-character-pubkey', c.pubkey)
                    e.dataTransfer.effectAllowed = 'copyMove'
                    // Use the portrait as the drag preview — the full card is
                    // too wide and hides the drop target.
                    const portrait = e.currentTarget.querySelector('.sandbox3-card-portrait')
                    if (portrait) {
                      try { e.dataTransfer.setDragImage(portrait, 28, 28) } catch {}
                    }
                  }}
                  onClick={() => runtime && setInspectedId(runtime.agentId)}
                  role="button"
                  tabIndex={0}
                  title={
                    runtime
                      ? "Click to inspect. Drag to move on the map. Use Profile to edit."
                      : "Drag onto the map to spawn. Use Profile to edit."
                  }
                >
                  <div className="sandbox3-card-portrait">
                    {c.avatarUrl ? (
                      <img src={c.avatarUrl} alt={c.name} draggable={false} />
                    ) : (
                      <div className="sandbox3-card-portrait-fallback">{initial}</div>
                    )}
                    {runtime && <span className="sandbox3-card-dot" title={thinking ? 'thinking' : 'listening'} />}
                  </div>
                  <div className="sandbox3-card-body">
                    <div className="sandbox3-card-name">{c.name}</div>
                    {runtime && (
                      <div className="sandbox3-card-status">
                        {thinking ? 'thinking…' : 'listening'} · {runtime.turns} turn{runtime.turns === 1 ? '' : 's'}
                      </div>
                    )}
                    {runtime?.lastUsage && (() => {
                      const total = runtime.lastUsage.totalTokens ?? 0
                      // Models in our catalog currently report contextWindow=131072;
                      // surface it here so the gauge scales as we add bigger models.
                      const cap = 131072
                      const pct = Math.min(100, (total / cap) * 100)
                      const level = pct > 80 ? 'red' : pct > 50 ? 'amber' : 'green'
                      return (
                        <div
                          className={`sandbox3-card-gauge level-${level}`}
                          title={`${total.toLocaleString()} / ${cap.toLocaleString()} tokens · ${pct.toFixed(1)}%`}
                        >
                          <div className="sandbox3-card-gauge-bar">
                            <div className="sandbox3-card-gauge-fill" style={{ width: `${pct}%` }} />
                          </div>
                          <span>{total.toLocaleString()}<small> / {(cap/1000).toFixed(0)}K</small></span>
                        </div>
                      )
                    })()}
                    {c.about && <p className="sandbox3-card-about">{c.about}</p>}
                    {c.state && (
                      <p className="sandbox3-card-state" title={c.state}>
                        <span className="sandbox3-card-state-label">state</span>
                        {c.state}
                      </p>
                    )}
                    <div className="sandbox3-card-actions">
                      <button
                        onClick={(e) => { e.stopPropagation(); setProfilePubkey(c.pubkey) }}
                      >
                        profile
                      </button>
                      {runtime && (
                        <button
                          onClick={(e) => { e.stopPropagation(); stopRuntime(runtime.agentId) }}
                          className="danger"
                        >
                          stop
                        </button>
                      )}
                      {!runtime && (
                        <span className="sandbox3-card-hint">drag to map →</span>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </aside>

      <section className="sandbox3-stage">
        <header>
          <h2>
            Room <small className={`status status-${roomStatus}`}>{roomStatus}</small>
          </h2>
          {roomError && <p className="agent-sandbox-error">{roomError}</p>}
        </header>

        <div className="sandbox3-map-frame">
          <RoomMap
            width={roomState.width}
            height={roomState.height}
            characters={characters}
            roomAgents={roomState.agents}
            adminPubkey={adminInfo?.pubkey}
            humanPubkey={humanInfo?.pubkey}
            onDropCharacter={onDropCharacter}
            onMoveSelf={onMoveSelf}
          />
          {dropToast && <div className="sandbox3-toast">{dropToast.text}</div>}
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

      {inspectedAgent && (
        <AgentInspector
          bridgeUrl={cfg.bridgeUrl}
          agent={inspectedAgent}
          onClose={() => setInspectedId(null)}
        />
      )}
      {profilePubkey && (
        <AgentProfile
          pubkey={profilePubkey}
          onClose={() => setProfilePubkey(null)}
          onUpdated={() => refresh()}
          onDeleted={() => { setProfilePubkey(null); refresh() }}
        />
      )}
    </div>
  )
}

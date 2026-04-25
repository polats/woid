import { useCallback, useEffect, useRef, useState } from 'react'
import config from './config.js'
import { useSandboxRoom } from './hooks/useSandboxRoom.js'
import { useSandboxSettings } from './hooks/useSandboxSettings.js'
import { useBridgeModels } from './hooks/useBridgeModels.js'
import AgentDrawer from './AgentDrawer.jsx'
import RoomMap from './RoomMap.jsx'
import SandboxSettings from './SandboxSettings.jsx'

const cfg = config.agentSandbox || {}
const JUMBLE_URL = cfg.jumbleUrl || 'http://localhost:18089'

export default function Sandbox() {
  const [characters, setCharacters] = useState([])
  const [adminInfo, setAdminInfo] = useState(null)
  const [chatDraft, setChatDraft] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState(null)
  // Unified drawer state — `inspectedId` can be an agentId (running
  // runtime) or a pubkey (any character, running or not). `drawerTab`
  // picks which tab opens first; users can flip it from inside.
  const [inspectedId, setInspectedId] = useState(null)
  const [drawerTab, setDrawerTab] = useState('context')
  const [creating, setCreating] = useState(false)
  const [spawnError, setSpawnError] = useState(null)
  const [humanInfo, setHumanInfo] = useState(null)
  const [dropToast, setDropToast] = useState(null)
  // Tracked profile-dirty flag from the drawer. We need it as a ref
  // (not just state) so the click handlers in the card list see the
  // current value at click time without re-binding on every re-render.
  const profileDirtyRef = useRef(false)
  const chatlogRef = useRef(null)

  // Wraps setInspectedId with a confirm prompt when the drawer's
  // profile tab has unsaved changes. Used by every place that might
  // swap the inspected character (card click, runtime click, etc).
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
      setInspectedId(c.pubkey)
      setDrawerTab('profile')
    } catch (err) {
      setSpawnError(err.message || String(err))
    }
  }

  // Resolve the (provider, model, harness, promptStyle) tuple for a
  // spawn. Same priority for all four: per-character manifest wins;
  // sidebar settings is the spawn default applied only when the
  // character has nothing pinned. Server fills in its own defaults if
  // both sides are empty.
  //
  // (We don't cross-validate model against /models here because the
  // catalog fetch can lag the first spawn on page load. The bridge
  // re-validates and falls back to its own default if the pair is
  // invalid.)
  function spawnBody(c, extra = {}) {
    let model, provider
    if (c.model) {
      const hit = models.find((m) => m.id === c.model)
      model = c.model
      if (hit) provider = hit.provider
    } else if (settings.provider && settings.model) {
      provider = settings.provider
      model = settings.model
    }
    const harness = c.harness || settings.harness
    const promptStyle = c.promptStyle || settings.promptStyle
    return {
      pubkey: c.pubkey,
      roomName: cfg.defaultRoom || 'sandbox',
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(harness ? { harness } : {}),
      ...(promptStyle ? { promptStyle } : {}),
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
      // Optimistically drop the runtime so the card reflects "stopped"
      // before the next 3s /characters poll — otherwise a quick drag-back
      // onto the map would try to MOVE the dead agent and hit /move 404.
      setCharacters((prev) => prev.map((c) =>
        c.runtime?.agentId === agentId ? { ...c, runtime: null } : c,
      ))
      if (inspectedId === agentId) setInspectedId(null)
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

  // Prefer the agentId match, but also accept a pubkey-only inspectedId
  // (set when clicking a non-running character on the map). Fall back to
  // a stub from inspectedId alone so the drawer still opens even while
  // /characters refresh is in-flight.
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
              const selected = inspectedId && (inspectedId === c.pubkey || inspectedId === runtime?.agentId)
              const initial = (c.name || '?').trim().charAt(0).toUpperCase()
              return (
                <li
                  key={c.pubkey}
                  className={`sandbox3-card${runtime ? ' running' : ''}${thinking ? ' thinking' : ''}${selected ? ' selected' : ''}`}
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
                  onClick={() => {
                    // Running → Context tab. Not running → Profile (only
                    // thing interesting about a stopped character is its
                    // config). Goes through safelySetInspectedId so we
                    // confirm before discarding unsaved profile edits.
                    safelySetInspectedId(
                      runtime ? runtime.agentId : c.pubkey,
                      runtime ? 'context' : 'profile',
                    )
                  }}
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
                    {(() => {
                      // Prefer the live runtime values for spawned chars;
                      // fall back to manifest. Two separate pills (model
                      // + brain) so a long model id can truncate inside
                      // its own pill without smushing the brain tag.
                      const h = runtime?.harness || c.harness
                      const isExternal = h === 'external'
                      // For external harness, the bridge `model` is a
                      // placeholder — the external client's own LLM does
                      // the thinking. Show its self-declared driver
                      // instead, or omit the pill if undeclared (the
                      // harness pill alone carries the signal).
                      const driver = runtime?.externalDriver || null
                      const m = isExternal ? driver : (runtime?.model || c.model)
                      if (!m && !h) return null
                      return (
                        <div className="sandbox3-card-tags">
                          {m && (
                            <span
                              className="sandbox3-card-tag sandbox3-card-tag-model"
                              title={isExternal ? `external driver: ${m}` : `model: ${m}`}
                            >
                              {isExternal ? m : m.split('/').pop()}
                            </span>
                          )}
                          {h && (
                            <span className="sandbox3-card-tag sandbox3-card-tag-harness" title={`brain: ${h}`}>
                              {h}
                            </span>
                          )}
                        </div>
                      )
                    })()}
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
                    {runtime && (
                      <div className="sandbox3-card-actions">
                        <button
                          onClick={(e) => { e.stopPropagation(); stopRuntime(runtime.agentId) }}
                          className="danger"
                        >
                          stop
                        </button>
                      </div>
                    )}
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
            onSelectCharacter={(pubkey) => {
              const c = characters.find((x) => x.pubkey === pubkey)
              // If running: inspect by runtime id. Otherwise open by pubkey
              // so the drawer shows past turns from the session file.
              safelySetInspectedId(
                c?.runtime?.agentId || pubkey,
                c?.runtime?.agentId ? 'context' : 'profile',
              )
            }}
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

      {/* Drawer is anchored to the right edge of the cards column and
          slides out from behind them; the stage shrinks via grid-
          template-columns to make room. */}
      {inspectedId && (
        <AgentDrawer
          bridgeUrl={cfg.bridgeUrl}
          character={inspectedCharacter}
          agent={inspectedAgent}
          initialTab={drawerTab}
          onDirtyChange={(d) => { profileDirtyRef.current = d }}
          onClose={() => { profileDirtyRef.current = false; setInspectedId(null) }}
          onUpdated={() => refresh()}
          onDeleted={() => { setInspectedId(null); refresh() }}
        />
      )}
    </div>
  )
}

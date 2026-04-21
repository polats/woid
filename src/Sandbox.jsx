import { useCallback, useEffect, useState } from 'react'
import config from '../woid.config.json'
import { useSandboxRoom } from './hooks/useSandboxRoom.js'
import AgentInspector from './AgentInspector.jsx'
import AgentProfile from './AgentProfile.jsx'

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

  const { status: roomStatus, state: roomState, error: roomError } = useSandboxRoom({
    url: cfg.roomServerUrl,
    roomName: cfg.defaultRoom || 'sandbox',
  })

  const refresh = useCallback(async () => {
    if (!cfg.bridgeUrl) return
    try {
      const j = await fetch(`${cfg.bridgeUrl}/characters`).then((r) => r.json())
      // /characters is the single source of truth — each entry nests
      // `runtime: { agentId, running, model, roomName, exitedAt, exitCode }`
      // when a runtime exists (running or within the reap grace period).
      setCharacters(j.characters || [])
    } catch {
      // transient fetch errors (e.g. containers restarting) are fine
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
  }, [])

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

  async function spawn(c) {
    if (c.runtime) { setInspectedId(c.runtime.agentId); return }
    setCreating(true)
    setSpawnError(null)
    try {
      const r = await fetch(`${cfg.bridgeUrl}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: c.pubkey,
          roomName: cfg.defaultRoom || 'sandbox',
          model: c.model || undefined,
        }),
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

  function copy(text) {
    try { navigator.clipboard?.writeText(text) } catch {}
  }

  // Resolve the character whose runtime matches the inspected id — the
  // inspector drawer reads the character's fields for the header.
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
    <div className="sandbox2">
      <div className="sandbox2-info">
        <div className="agent-sandbox-info-cell">
          <span className="agent-sandbox-info-label">Relay</span>
          <div className="agent-sandbox-info-val">
            <code>{cfg.relayUrl}</code>
          </div>
        </div>
        <div className="agent-sandbox-info-cell">
          <span className="agent-sandbox-info-label">Admin</span>
          <div className="agent-sandbox-info-val">
            {adminInfo ? (
              <>
                <strong>{adminInfo.profile?.name || 'Administrator'}</strong>
                <code title={adminInfo.pubkey}>{adminInfo.npub?.slice(0, 16)}…</code>
                <button className="agent-sandbox-info-copy" onClick={() => copy(adminInfo.npub)}>copy</button>
              </>
            ) : <span className="muted">loading…</span>}
          </div>
        </div>
        <div className="agent-sandbox-info-cell">
          <span className="agent-sandbox-info-label">Characters</span>
          <div className="agent-sandbox-info-val">
            <strong>{characters.length}</strong>
            <span className="muted">· {characters.filter((c) => c.runtime).length} running</span>
          </div>
        </div>
      </div>

      <aside className="sandbox2-cards">
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
          <ul className="sandbox2-card-list">
            {characters.map((c) => {
              // `runtime` is now an object or null, delivered inline by
              // /characters — no cross-lookup needed.
              const runtime = c.runtime?.running ? c.runtime : null
              const initial = (c.name || '?').trim().charAt(0).toUpperCase()
              return (
                <li
                  key={c.pubkey}
                  className={`sandbox2-card${runtime ? ' running' : ''}`}
                  onClick={() => setProfilePubkey(c.pubkey)}
                  role="button"
                  tabIndex={0}
                  draggable
                  title="Click to edit profile. Drag (once the 2D map lands) to place."
                >
                  <div className="sandbox2-card-portrait">
                    {c.avatarUrl ? (
                      <img src={c.avatarUrl} alt={c.name} draggable={false} />
                    ) : (
                      <div className="sandbox2-card-portrait-fallback">{initial}</div>
                    )}
                    {runtime && (
                      <span className="sandbox2-card-runtime-dot" title="running" />
                    )}
                  </div>
                  <div className="sandbox2-card-body">
                    <div className="sandbox2-card-name">{c.name}</div>
                    {c.about && <p className="sandbox2-card-about">{c.about}</p>}
                    <div className="sandbox2-card-footer">
                      {c.model && (
                        <span className="agent-model-badge" title={c.model}>
                          {c.model.split('/').pop()}
                        </span>
                      )}
                      <span className="sandbox2-card-actions">
                        {runtime ? (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); setInspectedId(runtime.agentId) }}
                            >
                              inspect
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); stopRuntime(runtime.agentId) }}
                              className="danger"
                            >
                              stop
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); spawn(c) }}
                            disabled={creating}
                            className="primary"
                          >
                            spawn
                          </button>
                        )}
                      </span>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </aside>

      <section className="sandbox2-room">
        <header>
          <h2>Room <small className={`status status-${roomStatus}`}>{roomStatus}</small></h2>
          {roomError && <p className="agent-sandbox-error">{roomError}</p>}
        </header>
        <div className="sandbox2-room-body">
          <h3>Presence ({roomState.agents.length})</h3>
          {roomState.agents.length === 0 ? (
            <p className="muted">No agents in the room. Spawn one from the cards on the left.</p>
          ) : (
            <ul className="agent-sandbox-list">
              {roomState.agents.map((a) => (
                <li key={a.sessionId}>
                  <strong>{a.name}</strong>
                  {a.isAgent && <span className="muted">agent</span>}
                </li>
              ))}
            </ul>
          )}
          <h3>Recent chat ({roomState.messages.length})</h3>
          <ul className="agent-sandbox-messages">
            {roomState.messages.slice().reverse().map((m, i) => (
              <li key={m.ts + i}>
                <strong>{m.from}:</strong> {m.text}
              </li>
            ))}
            {roomState.messages.length === 0 && <li className="muted">—</li>}
          </ul>
          <p className="muted sandbox2-tip">
            The live <a href="#/relay-feed">relay feed</a> is in its own sidebar section.
          </p>
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

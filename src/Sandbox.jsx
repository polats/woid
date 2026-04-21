import { useCallback, useEffect, useState } from 'react'
import config from '../woid.config.json'
import { useSandboxRoom } from './hooks/useSandboxRoom.js'
import AgentInspector from './AgentInspector.jsx'
import AgentProfile from './AgentProfile.jsx'

const cfg = config.agentSandbox || {}

export default function Sandbox() {
  const [characters, setCharacters] = useState([])
  const [agents, setAgents] = useState([])
  const [adminInfo, setAdminInfo] = useState(null)
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
      const [ch, ag] = await Promise.all([
        fetch(`${cfg.bridgeUrl}/characters`).then((r) => r.json()),
        fetch(`${cfg.bridgeUrl}/agents`).then((r) => r.json()),
      ])
      setCharacters(ch.characters || [])
      setAgents(ag.agents || [])
    } catch {
      // silent — transient fetch errors are common while containers restart
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

  function copy(text) {
    try { navigator.clipboard?.writeText(text) } catch {}
  }

  // Merge characters with their running runtime metadata for the inspector.
  const inspectedAgent = agents.find((a) => a.agentId === inspectedId)

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
              const runtime = c.runtime
                ? agents.find((a) => a.agentId === c.runtime.agentId)
                : null
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
            The live <a href="#/relay-feed">relay feed</a> is now in its own sidebar section.
          </p>
        </div>
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

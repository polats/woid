import { useCallback, useEffect, useState } from 'react'
import config from '../woid.config.json'
import { useSandboxRoom } from './hooks/useSandboxRoom.js'
import { useRelayFeed } from './hooks/useRelayFeed.js'
import AgentInspector from './AgentInspector.jsx'

const cfg = config.agentSandbox || {}

export default function Sandbox() {
  const [agents, setAgents] = useState([])
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', seedMessage: '', model: '' })
  const [createError, setCreateError] = useState(null)
  const [inspectedId, setInspectedId] = useState(null)
  const [adminInfo, setAdminInfo] = useState(null)
  const [modelCatalog, setModelCatalog] = useState({ default: '', models: [] })

  const { status: roomStatus, state: roomState, error: roomError } = useSandboxRoom({
    url: cfg.roomServerUrl,
    roomName: cfg.defaultRoom || 'sandbox',
  })
  const { events: relayEvents, status: relayStatus } = useRelayFeed({
    url: cfg.relayUrl,
    kinds: [1],
    limit: 50,
  })

  const refreshAgents = useCallback(async () => {
    if (!cfg.bridgeUrl) return
    try {
      const r = await fetch(`${cfg.bridgeUrl}/agents`)
      const j = await r.json()
      setAgents(j.agents || [])
    } catch {
      setAgents([])
    }
  }, [])

  useEffect(() => {
    refreshAgents()
    const t = setInterval(refreshAgents, 3000)
    return () => clearInterval(t)
  }, [refreshAgents])

  useEffect(() => {
    if (!cfg.bridgeUrl) return
    fetch(`${cfg.bridgeUrl}/admin`).then((r) => r.json()).then(setAdminInfo).catch(() => {})
    fetch(`${cfg.bridgeUrl}/models`).then((r) => r.json()).then((j) => {
      setModelCatalog(j)
      setForm((f) => (f.model ? f : { ...f, model: j.default }))
    }).catch(() => {})
  }, [])

  async function createAgent(e) {
    e.preventDefault()
    if (!form.name.trim()) return
    setCreating(true)
    setCreateError(null)
    try {
      const r = await fetch(`${cfg.bridgeUrl}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          seedMessage: form.seedMessage.trim() || undefined,
          roomName: cfg.defaultRoom || 'sandbox',
          model: form.model || undefined,
        }),
      })
      if (!r.ok) throw new Error(await r.text())
      setForm((f) => ({ name: '', seedMessage: '', model: f.model }))
      await refreshAgents()
    } catch (err) {
      setCreateError(err.message || String(err))
    } finally {
      setCreating(false)
    }
  }

  async function stopAgent(id) {
    try {
      await fetch(`${cfg.bridgeUrl}/agents/${id}`, { method: 'DELETE' })
      await refreshAgents()
    } catch {}
  }

  const npubToName = new Map()
  for (const a of agents) if (a.npub) npubToName.set(a.npub, a.name)
  for (const a of roomState.agents) if (a.npub) npubToName.set(a.npub, a.name)
  if (adminInfo?.pubkey) npubToName.set(adminInfo.pubkey, adminInfo.profile?.name || 'Administrator')

  const adminEventCount = adminInfo?.pubkey
    ? relayEvents.filter((e) => e.pubkey === adminInfo.pubkey).length
    : 0

  function copy(text) {
    try { navigator.clipboard?.writeText(text) } catch {}
  }

  return (
    <div className="agent-sandbox">
      <div className="agent-sandbox-info">
        <div className="agent-sandbox-info-cell">
          <span className="agent-sandbox-info-label">Relay</span>
          <code>{cfg.relayUrl}</code>
          <span className={`status status-${relayStatus}`}>{relayStatus}</span>
        </div>
        <div className="agent-sandbox-info-cell">
          <span className="agent-sandbox-info-label">Admin</span>
          {adminInfo ? (
            <>
              <strong>{adminInfo.profile?.name || 'Administrator'}</strong>
              <code title={adminInfo.pubkey}>{adminInfo.npub?.slice(0, 16)}…</code>
              <button
                className="agent-sandbox-info-copy"
                onClick={() => copy(adminInfo.npub)}
                title="Copy npub"
              >
                copy
              </button>
            </>
          ) : <span className="muted">loading…</span>}
        </div>
        <div className="agent-sandbox-info-cell">
          <span className="agent-sandbox-info-label">Events</span>
          <span>{relayEvents.length} total</span>
          <span className="muted">· {adminEventCount} from admin</span>
        </div>
      </div>

      <div className="agent-sandbox-pane">
        <h2>Create agent</h2>
        <form onSubmit={createAgent} className="agent-sandbox-form">
          <label>
            Name
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. scout"
              disabled={creating}
            />
          </label>
          <label>
            Model
            <select
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              disabled={creating || modelCatalog.models.length === 0}
            >
              {modelCatalog.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.activeParamsB ? ` (${m.activeParamsB}B)` : m.totalParamsB ? ` (${m.totalParamsB}B)` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seed message (optional)
            <textarea
              value={form.seedMessage}
              onChange={(e) => setForm((f) => ({ ...f, seedMessage: e.target.value }))}
              placeholder="First instruction the agent sees. e.g. 'introduce yourself to the room'"
              rows={4}
              disabled={creating}
            />
          </label>
          <button type="submit" disabled={creating || !form.name.trim()}>
            {creating ? 'Spawning…' : 'Spawn'}
          </button>
          {createError && <p className="agent-sandbox-error">{createError}</p>}
        </form>

        <h3>Active agents</h3>
        {agents.length === 0 ? (
          <p className="muted">No agents yet.</p>
        ) : (
          <ul className="agent-sandbox-list">
            {agents.map((a) => (
              <li
                key={a.agentId}
                className={`agent-sandbox-agent-row${inspectedId === a.agentId ? ' selected' : ''}`}
                onClick={() => setInspectedId(a.agentId)}
                role="button"
                tabIndex={0}
              >
                <strong>{a.name}</strong>
                {a.model && (
                  <span className="agent-model-badge" title={a.model}>
                    {a.model.split('/').pop()}
                  </span>
                )}
                <code title={a.npub}>{a.npub.slice(0, 12)}…</code>
                <span className="muted">{a.running ? 'running' : 'stopped'}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); stopAgent(a.agentId) }}
                >
                  stop
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="agent-sandbox-pane">
        <h2>Room <small className={`status status-${roomStatus}`}>{roomStatus}</small></h2>
        {roomError && <p className="agent-sandbox-error">{roomError}</p>}
        <h3>Presence ({roomState.agents.length})</h3>
        <ul className="agent-sandbox-list">
          {roomState.agents.map((a) => (
            <li key={a.sessionId}>
              <strong>{a.name}</strong>
              {a.isAgent && <span className="muted">agent</span>}
            </li>
          ))}
        </ul>
        <h3>Recent chat ({roomState.messages.length})</h3>
        <ul className="agent-sandbox-messages">
          {roomState.messages.slice().reverse().map((m, i) => (
            <li key={m.ts + i}>
              <strong>{m.from}:</strong> {m.text}
            </li>
          ))}
        </ul>
      </div>

      <div className="agent-sandbox-pane">
        <h2>Relay feed <small className={`status status-${relayStatus}`}>{relayStatus}</small></h2>
        <p className="muted">kind:1 events from {cfg.relayUrl}</p>
        <ul className="agent-sandbox-messages">
          {relayEvents.map((ev) => (
            <li key={ev.id}>
              <strong>{npubToName.get(ev.pubkey) || ev.pubkey.slice(0, 8)}:</strong> {ev.content}
            </li>
          ))}
          {relayEvents.length === 0 && <li className="muted">Waiting for events…</li>}
        </ul>
      </div>

      {inspectedId && (
        <AgentInspector
          bridgeUrl={cfg.bridgeUrl}
          agent={agents.find((a) => a.agentId === inspectedId) || { agentId: inspectedId, name: 'agent', npub: '' }}
          onClose={() => setInspectedId(null)}
        />
      )}
    </div>
  )
}

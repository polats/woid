import { useEffect, useMemo, useState } from 'react'
import config from '../config.js'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { formatSimTime, simDay, tickAgents } from '../lib/shelterStore/index.js'

/**
 * Floating dev menu for the Shelter view. Two unified rosters —
 * NPCs (kind:'npc' bridge chars; content) and Players (kind:'player'
 * bridge chars; recruitable employees) — each row a single toggle.
 * Press `+` to add the agent, `×` to remove. Active rows float to
 * the top of each section so toggling feels stable.
 *
 * Avatars: bridge characters show their `/characters/:pubkey/avatar`
 * thumbnail; if missing, a deterministic letter chip stands in.
 */

function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function Avatar({ item }) {
  if (item.avatarUrl) {
    return <img src={item.avatarUrl} alt="" className="shelter-debug-avatar" />
  }
  const letter = (item.name || '?').charAt(0).toUpperCase()
  const hue = hashCode(item.id) % 360
  return (
    <div
      className="shelter-debug-avatar fallback"
      style={{ background: `hsl(${hue}, 28%, 38%)` }}
    >
      {letter}
    </div>
  )
}

function stateLabel(agent) {
  if (!agent) return null
  if (agent.state === 'walking' && agent.assignment?.roomId) {
    return `walking → ${agent.assignment.roomId}`
  }
  if (agent.assignment?.roomId) {
    return `${agent.state} @ ${agent.assignment.roomId}`
  }
  return agent.state
}

function RosterRow({ item, agent, onAdd, onRemove }) {
  const isActive = !!agent
  return (
    <li className={`shelter-debug-roster-item${isActive ? ' active' : ''}`}>
      <Avatar item={item} />
      <div className="shelter-debug-roster-meta">
        <div className="name">{item.name}</div>
        {isActive && <div className="state">{stateLabel(agent)}</div>}
      </div>
      <button
        type="button"
        onClick={() => (isActive ? onRemove(agent.id) : onAdd(item))}
        title={isActive ? 'Remove' : 'Add'}
      >
        {isActive ? '×' : '+'}
      </button>
    </li>
  )
}

export default function ShelterDebug() {
  const [open, setOpen] = useState(false)
  const snapshot = useShelterStore()
  const store = useShelterStoreApi()
  const [npcChars, setNpcChars] = useState([])
  const [playerChars, setPlayerChars] = useState([])
  const [bridgeStatus, setBridgeStatus] = useState('idle')
  const cfg = config.agentSandbox || {}

  // Backtick / tilde toggles the panel — same key in any keyboard
  // layout (`e.code === 'Backquote'`). Suppressed while typing in
  // an input so it doesn't fight with text entry.
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Backquote') return
      const t = e.target
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
      e.preventDefault()
      setOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open || !cfg.bridgeUrl) return
    let cancelled = false
    setBridgeStatus('loading')
    Promise.all([
      fetch(`${cfg.bridgeUrl}/characters?kind=npc`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${cfg.bridgeUrl}/characters?kind=player`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([npcData, playerData]) => {
        if (cancelled) return
        setNpcChars(npcData?.characters ?? [])
        setPlayerChars(playerData?.characters ?? [])
        setBridgeStatus('ok')
      })
      .catch(() => { if (!cancelled) setBridgeStatus('error') })
    return () => { cancelled = true }
  }, [open, cfg.bridgeUrl])

  // Build unified roster items so each list row can render with the
  // same component regardless of source.
  const npcItems = useMemo(() => npcChars.map((c) => ({
    kind: 'npc',
    id: `npc-${c.pubkey.slice(0, 12)}`,
    name: c.name ?? c.pubkey.slice(0, 8),
    role: c.npc_role ?? null,
    avatarUrl: cfg.bridgeUrl ? `${cfg.bridgeUrl}/characters/${c.pubkey}/avatar` : null,
    pubkey: c.pubkey,
    addPayload: {
      id: `npc-${c.pubkey.slice(0, 12)}`,
      name: c.name ?? 'Unnamed',
      kind: 'npc',
      pubkey: c.pubkey,
      pos: c.npc_default_pos ?? null,
      // npc_role is bridge metadata; we mirror it onto the agent for
      // future role-based lookup without round-tripping the bridge.
      role: c.npc_role ?? null,
    },
  })), [npcChars, cfg.bridgeUrl])

  const playerItems = useMemo(() => playerChars.map((c) => ({
    kind: 'player',
    id: `bridge-${c.pubkey.slice(0, 12)}`,
    name: c.name ?? c.pubkey.slice(0, 8),
    avatarUrl: cfg.bridgeUrl ? `${cfg.bridgeUrl}/characters/${c.pubkey}/avatar` : null,
    pubkey: c.pubkey,
    addPayload: {
      id: `bridge-${c.pubkey.slice(0, 12)}`,
      name: c.name ?? 'Unnamed',
      pubkey: c.pubkey,
      scheduleId: 'worker',
      llmEnabled: false,
    },
  })), [playerChars, cfg.bridgeUrl])

  const agentsById = snapshot?.agents ?? {}
  const agentsByPubkey = useMemo(() => {
    const m = new Map()
    for (const a of Object.values(agentsById)) {
      if (a.pubkey) m.set(a.pubkey, a)
    }
    return m
  }, [agentsById])

  const resolveAgent = (item) => {
    if (item.pubkey) return agentsByPubkey.get(item.pubkey) ?? null
    return agentsById[item.id] ?? null
  }
  // Match the agent-sandbox order: dummies in declaration order,
  // bridge characters in the order /characters returned (already
  // sorted by createdAt desc on the bridge). Within each list,
  // active items float to the top — but otherwise we preserve the
  // incoming sequence so the menu mirrors the sandbox view.
  const sortRoster = (items) => {
    const active = items.filter((it) => resolveAgent(it))
    const inactive = items.filter((it) => !resolveAgent(it))
    return [...active, ...inactive]
  }
  const sortedNpcs = useMemo(() => sortRoster(npcItems), [npcItems, agentsById])
  const sortedPlayers = useMemo(() => sortRoster(playerItems), [playerItems, agentsById])

  const add = (item) => {
    store.addAgent(item.addPayload)
    tickAgents(store)
  }
  const remove = (id) => store.removeAgent(id)
  const fastForward = () => { store.fastForward(60); tickAgents(store) }
  const dump = () => console.log('[shelter] snapshot', store.getSnapshot())
  const clearAll = () => {
    if (confirm('Clear all Shelter state? This wipes localStorage.')) store.clear()
  }

  const activeCount = Object.keys(agentsById).length

  return (
    <>
      <button
        type="button"
        className={`shelter-debug-button${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Shelter debug menu (~ / `)"
      >
        DEV
      </button>
      {open && (
        <div className="shelter-debug-panel">
          <div className="shelter-debug-header">
            <span>Shelter Debug</span>
            <button type="button" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="shelter-debug-status">
            Day {simDay(snapshot?.simMinutes ?? 0)} · {formatSimTime(snapshot?.simMinutes ?? 0)}
            {' · '}
            {activeCount} agent{activeCount === 1 ? '' : 's'}
          </div>

          <h4>
            NPCs
            <span className="shelter-debug-hint">
              {bridgeStatus === 'loading' && '…'}
              {bridgeStatus === 'error' && '(unreachable)'}
              {bridgeStatus === 'ok' && `(${npcChars.length})`}
            </span>
          </h4>
          {bridgeStatus === 'ok' && npcChars.length === 0 && (
            <p className="shelter-debug-empty">No NPCs yet — create one in the NPCs view.</p>
          )}
          <ul className="shelter-debug-roster">
            {sortedNpcs.map((item) => (
              <RosterRow
                key={item.id}
                item={item}
                agent={resolveAgent(item)}
                onAdd={add}
                onRemove={remove}
              />
            ))}
          </ul>

          <h4>
            Players
            <span className="shelter-debug-hint">
              {bridgeStatus === 'loading' && '…'}
              {bridgeStatus === 'error' && '(unreachable)'}
              {bridgeStatus === 'ok' && `(${playerChars.length})`}
            </span>
          </h4>
          {bridgeStatus === 'ok' && playerChars.length === 0 && (
            <p className="shelter-debug-empty">No player characters in the bridge.</p>
          )}
          <ul className="shelter-debug-roster">
            {sortedPlayers.map((item) => (
              <RosterRow
                key={item.id}
                item={item}
                agent={resolveAgent(item)}
                onAdd={add}
                onRemove={remove}
              />
            ))}
          </ul>

          <div className="shelter-debug-actions">
            <button type="button" onClick={fastForward}>Fast-forward 1h</button>
            <button type="button" onClick={dump}>Dump JSON</button>
            <button type="button" onClick={clearAll}>Clear all</button>
          </div>
        </div>
      )}
    </>
  )
}

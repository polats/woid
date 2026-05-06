import { useEffect, useMemo, useState } from 'react'
import config from '../config.js'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { formatSimTime, simDay, tickAgents } from '../lib/shelterStore/index.js'

/**
 * Floating dev menu for the Shelter view. Two unified rosters
 * (local dummies + bridge characters), each row a single toggle —
 * pressing `+` adds the agent, pressing `×` removes them. Active
 * agents float to the top of each section so toggling feels stable.
 *
 * Avatars: bridge characters show their `/characters/:pubkey/avatar`
 * thumbnail; dummies show a deterministic letter chip.
 */

const DUMMY_ROSTER = [
  { id: 'dummy-alice',    name: 'Alice',  traits: { focus: 0.7, social: 0.3 } },
  { id: 'dummy-bob',      name: 'Bob',    traits: { focus: 0.4, social: 0.8 } },
  { id: 'dummy-carla',    name: 'Carla',  traits: { focus: 0.6, social: 0.6 } },
  { id: 'dummy-dmitri',   name: 'Dmitri', traits: { focus: 0.8, social: 0.2 } },
]

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
  const [bridgeChars, setBridgeChars] = useState([])
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
    fetch(`${cfg.bridgeUrl}/characters`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        setBridgeChars(data?.characters ?? [])
        setBridgeStatus('ok')
      })
      .catch(() => { if (!cancelled) setBridgeStatus('error') })
    return () => { cancelled = true }
  }, [open, cfg.bridgeUrl])

  // Build unified roster items so each list row can render with the
  // same component regardless of source.
  const dummyItems = useMemo(() => DUMMY_ROSTER.map((d) => ({
    kind: 'dummy',
    id: d.id,
    name: d.name,
    avatarUrl: null,
    pubkey: null,
    addPayload: {
      id: d.id, name: d.name, traits: d.traits,
      scheduleId: 'worker', llmEnabled: false,
    },
  })), [])

  const bridgeItems = useMemo(() => bridgeChars.map((c) => ({
    kind: 'bridge',
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
  })), [bridgeChars, cfg.bridgeUrl])

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
  const sortedDummies = useMemo(() => sortRoster(dummyItems), [dummyItems, agentsById])
  const sortedBridge = useMemo(() => sortRoster(bridgeItems), [bridgeItems, agentsById])

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

          <h4>Local roster</h4>
          <ul className="shelter-debug-roster">
            {sortedDummies.map((item) => (
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
            Bridge characters
            <span className="shelter-debug-hint">
              {bridgeStatus === 'loading' && '…'}
              {bridgeStatus === 'error' && '(unreachable)'}
              {bridgeStatus === 'ok' && `(${bridgeChars.length})`}
            </span>
          </h4>
          {bridgeStatus === 'ok' && bridgeChars.length === 0 && (
            <p className="shelter-debug-empty">No characters in the bridge.</p>
          )}
          <ul className="shelter-debug-roster">
            {sortedBridge.map((item) => (
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

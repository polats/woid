import { useEffect, useMemo, useState } from 'react'
import config from '../config.js'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { formatSimTime, simDay, tickAgents } from '../lib/shelterStore/index.js'
import { useTutorialHost } from '../hooks/useTutorialHost.js'
import tutorialScripts from '../lib/tutorial/scripts.json'

/**
 * Floating dev menu for the Shelter view, restructured with a vertical
 * side-tab rail (mirrors the AgentDrawer pattern):
 *
 *   ┌──┬──────────────────────────┐
 *   │N │  NPCs roster             │
 *   │P │                          │
 *   │T │                          │
 *   └──┴──────────────────────────┘
 *
 * Tabs:
 *   NPCs      — bridge characters with kind:'npc' (toggle to spawn)
 *   Players   — bridge characters with kind:'player' (toggle to spawn)
 *   Tutorial  — list of guided-tutorial steps with Play/Reset
 *
 * Press `+` to add the agent, `×` to remove. Active rows float to the
 * top of each section so toggling feels stable.
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

const TABS = [
  { id: 'npcs',     label: 'NPCs',     Icon: IconNpcs },
  { id: 'players',  label: 'Players',  Icon: IconPlayers },
  { id: 'tutorial', label: 'Tutorial', Icon: IconTutorial },
]

export default function ShelterDebug() {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('npcs')
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

  // ── Tutorial host ─────────────────────────────────────────────────
  // The hook owns the runtime ctx (resolveCharacter / walk / walkIn /
  // focus / camera / clearTutorialOverrides / findStep), the NPC
  // roster fetch for role lookups, and the non-NPC scrub on play /
  // reset. The dev panel just calls play(step) / reset() and reads
  // tutorial.state for the active-step indicator.
  const tutorial = useTutorialHost({
    scripts: tutorialScripts,
    bridgeUrl: cfg.bridgeUrl,
  })

  const playStep = (step) => {
    // Close the dev panel so the tutorial owns the screen — backtick
    // still re-opens it if the player needs to bail mid-step.
    setOpen(false)
    tutorial.play(step)
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
        <div className="shelter-debug-panel has-tabs">
          <div className="shelter-debug-header">
            <span>Shelter Debug</span>
            <button type="button" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="shelter-debug-status">
            Day {simDay(snapshot?.simMinutes ?? 0)} · {formatSimTime(snapshot?.simMinutes ?? 0)}
            {' · '}
            {activeCount} agent{activeCount === 1 ? '' : 's'}
          </div>

          <div className="shelter-debug-body">
            <nav className="shelter-debug-sidetabs" role="tablist">
              {TABS.map((t) => {
                const Icon = t.Icon
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === t.id}
                    className={`shelter-debug-sidetab${activeTab === t.id ? ' active' : ''}`}
                    onClick={() => setActiveTab(t.id)}
                    title={t.label}
                  >
                    <Icon />
                    <span>{t.label}</span>
                  </button>
                )
              })}
            </nav>

            <div className="shelter-debug-tabpanel" role="tabpanel">
              {activeTab === 'npcs' && (
                <>
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
                </>
              )}

              {activeTab === 'players' && (
                <>
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
                </>
              )}

              {activeTab === 'tutorial' && (
                <>
                  <h4>
                    Tutorial
                    {tutorial.isActive && (
                      <span className="shelter-debug-hint">
                        running · step {tutorial.state.actionIndex + 1}
                      </span>
                    )}
                  </h4>
                  <ul className="shelter-debug-tutorial">
                    {(tutorialScripts.steps ?? []).map((step) => {
                      const isRunning = tutorial.isActive && tutorial.state.stepId === step.id
                      return (
                        <li key={step.id} className={`shelter-debug-tutorial-step${isRunning ? ' active' : ''}`}>
                          <div className="shelter-debug-tutorial-meta">
                            <strong>{step.name}</strong>
                            {step.summary && <p>{step.summary}</p>}
                            <code>{step.actions.length} action{step.actions.length === 1 ? '' : 's'}</code>
                          </div>
                          <button
                            type="button"
                            onClick={() => playStep(step)}
                            disabled={isRunning}
                            title={isRunning ? 'Already running' : 'Play this step'}
                          >
                            ▶
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                  {tutorial.isActive && (
                    <button
                      type="button"
                      className="shelter-debug-tutorial-reset"
                      onClick={tutorial.reset}
                    >
                      Reset
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

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

function IconNpcs() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4.5 5-6.5 8-6.5s6.5 2 8 6.5" />
    </svg>
  )
}

function IconPlayers() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="9" r="3.2" />
      <circle cx="17" cy="10" r="2.4" />
      <path d="M3 20c1-3.5 3.5-5 6-5s5 1.5 6 5" />
      <path d="M14 20c.6-2.4 2.2-3.6 4-3.6s3 .9 3.4 2.6" />
    </svg>
  )
}

function IconTutorial() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6c4-1.6 8-1 8 1.4V20c0-2.4-4-3-8-1.4z" />
      <path d="M20 6c-4-1.6-8-1-8 1.4V20c0-2.4 4-3 8-1.4z" />
    </svg>
  )
}

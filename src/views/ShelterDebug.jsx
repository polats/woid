import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import config from '../config.js'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { formatSimTime, simDay, tickAgents } from '../lib/shelterStore/index.js'
import tutorialScripts from '../lib/tutorial/scripts.json'
import { play as playTutorial, reset as resetTutorial, subscribe as subscribeTutorial, getState as getTutorialState } from '../lib/tutorial/runtime.js'
import {
  focusAgent as stageFocusAgent,
  exitFocus as stageExitFocus,
  walkAgent as stageWalkAgent,
  panCamera as stagePanCamera,
  walkInAgent as stageWalkInAgent,
  cameraTo as stageCameraTo,
  clearTutorialOverrides as stageClearTutorialOverrides,
} from '../lib/shelterStageBus.js'

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

  // ── Tutorial helpers ──────────────────────────────────────────────
  // resolveCharacter is given to the runtime so dialog actions can
  // populate speaker name / avatar from whatever NPCs are currently
  // spawned. role lookup goes through the shelter snapshot first,
  // then the bridge roster as a fallback (so the tutorial works even
  // before the NPC has been added to the diorama).
  const resolveCharacter = ({ role, pubkey } = {}) => {
    if (pubkey) {
      const agent = agentsByPubkey.get(pubkey)
      if (agent) {
        return { name: agent.name, pubkey, avatarUrl: cfg.bridgeUrl ? `${cfg.bridgeUrl}/characters/${pubkey}/avatar` : null }
      }
      const c = [...npcChars, ...playerChars].find((x) => x.pubkey === pubkey)
      if (c) return { name: c.name, pubkey, avatarUrl: cfg.bridgeUrl ? `${cfg.bridgeUrl}/characters/${pubkey}/avatar` : null }
    }
    if (role) {
      for (const a of Object.values(agentsById)) {
        if (a.role === role && a.pubkey) {
          return { name: a.name, pubkey: a.pubkey, avatarUrl: cfg.bridgeUrl ? `${cfg.bridgeUrl}/characters/${a.pubkey}/avatar` : null }
        }
      }
      const c = npcChars.find((x) => x.npc_role === role)
      if (c) return { name: c.name, pubkey: c.pubkey, avatarUrl: cfg.bridgeUrl ? `${cfg.bridgeUrl}/characters/${c.pubkey}/avatar` : null }
    }
    return null
  }

  // For focusCharacterRole — we need an agent.id to drive the stage's
  // focusAgent. If the NPC isn't spawned yet, auto-add them so the
  // tutorial can still run from a cold cache.
  const focusCharacterByPubkey = async (pubkey, opts) => {
    let agent = agentsByPubkey.get(pubkey)
    if (!agent) {
      const c = npcChars.find((x) => x.pubkey === pubkey)
      if (c) {
        const item = npcItems.find((x) => x.pubkey === pubkey)
        if (item) {
          add(item)
          // Give the store + stage a beat to spawn the avatar before
          // we ask the camera to focus it.
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    }
    const fresh = store.getSnapshot()?.agents ?? {}
    const target = Object.values(fresh).find((a) => a.pubkey === pubkey)
    if (target) stageFocusAgent(target.id, opts)
  }

  const tutorialState = useSyncExternalStore(subscribeTutorial, getTutorialState)

  const playStep = (step) => {
    // Close the dev panel so the tutorial owns the screen — backtick
    // still re-opens it if the player needs to bail mid-step.
    setOpen(false)
    // Same scrub the Reset button does — non-NPC agents from a
    // previous run could be at stale rooms and confuse the cinematic.
    {
      const snap = store.getSnapshot()?.agents ?? {}
      for (const [id, a] of Object.entries(snap)) {
        if (a.kind !== 'npc') store.removeAgent(id)
      }
    }
    playTutorial(step, {
      resolveCharacter,
      focusCharacter: focusCharacterByPubkey,
      exitFocus: () => { stageExitFocus() },
      walkAgent: (pubkey, dx, dy, ms) => stageWalkAgent({ pubkey, dx, dy, ms }),
      panCamera: (dx, dy, ms) => stagePanCamera({ dx, dy, ms }),
      cameraTo: (state, ms) => stageCameraTo({ state, ms }),
      clearTutorialOverrides: () => stageClearTutorialOverrides(),
      // Adds the hired character to the Shelter store if it isn't
      // already there (so the stage has a wrapper to animate), then
      // hands off to the bus for the off-camera-park-and-walk-in.
      // Critical: the avatar sync loop SKIPS agents with `pos: null`,
      // so we explicitly seed pos to the focused NPC's room — that's
      // why the new recruit was previously invisible.
      walkInHired: async (pubkey, fromOffsetX, dx, ms) => {
        console.log('[tutorial-walkin] ShelterDebug.walkInHired called', { pubkey, fromOffsetX, dx, ms })
        const fresh = store.getSnapshot()?.agents ?? {}
        const existing = Object.values(fresh).find((a) => a.pubkey === pubkey)
        console.log('[tutorial-walkin] already in store?', !!existing, 'pos:', existing?.pos, 'agents in store:', Object.values(fresh).length)

        // Anchor the recruit to Edi's room (the receptionist) — the
        // schedule resolver may have scattered them to wellness-1 etc.
        // on a previous run, and on a fresh run we want them right next
        // to Edi for the walk-in cinematic.
        const liveAgents = Object.values(fresh)
        const anchor = liveAgents.find((a) => a.role === 'receptionist')
                      ?? liveAgents.find((a) => a.kind === 'npc' && a.pos?.roomId)
                      ?? liveAgents.find((a) => a.pos?.roomId)
        const seedPos = anchor?.pos?.roomId
          ? { roomId: anchor.pos.roomId, localU: 0.9, localV: 0.5 }
          : null
        console.log('[tutorial-walkin] anchor:', anchor?.id, 'role:', anchor?.role, 'seedPos:', seedPos)
        if (!seedPos) {
          console.warn('[tutorial-walkin] no anchor room found, aborting')
          return
        }

        if (existing) {
          // Re-park the existing record at the seed and clear any
          // walk/pace/assignment leftovers so the resolver doesn't
          // immediately pull them away again. Crucially we DO NOT
          // call tickAgents — that's what moved them to wellness-1
          // in the first place.
          console.log('[tutorial-walkin] re-parking existing agent at seed', existing.id)
          store.updateAgent(existing.id, {
            pos: seedPos,
            walkFrom: null, walkTo: null,
            paceFrom: null, paceTo: null,
            paceMode: null, paceStartedAt: null,
            paceRestUntil: null, paceRestRole: null,
            assignment: null,
            state: 'idle',
          })
        } else {
          // Build an addPayload — prefer the local rosters, fall back
          // to a direct bridge fetch if the panel was never opened.
          let item = playerItems.find((x) => x.pubkey === pubkey)
                  ?? npcItems.find((x) => x.pubkey === pubkey)
          console.log('[tutorial-walkin] item found in rosters?', !!item,
            'playerItems:', playerItems.length, 'npcItems:', npcItems.length)
          if (!item && cfg.bridgeUrl) {
            console.log('[tutorial-walkin] fetching character from bridge', pubkey)
            try {
              const r = await fetch(`${cfg.bridgeUrl}/characters/${pubkey}`)
              console.log('[tutorial-walkin] bridge fetch status:', r.status)
              if (r.ok) {
                const c = await r.json()
                console.log('[tutorial-walkin] bridge returned character:', c.name, 'kind:', c.kind)
                item = {
                  kind: c.kind ?? 'player',
                  id: `bridge-${pubkey.slice(0, 12)}`,
                  name: c.name ?? 'Unnamed',
                  pubkey,
                  addPayload: {
                    id: `bridge-${pubkey.slice(0, 12)}`,
                    name: c.name ?? 'Unnamed',
                    pubkey,
                    // No scheduleId — the schedule resolver is what
                    // moved past hires to wellness-1; for the
                    // cinematic we just want them parked at Edi's
                    // room until the player drives them elsewhere.
                    llmEnabled: false,
                  },
                }
              }
            } catch (err) {
              console.warn('[tutorial-walkin] bridge fetch failed', err)
            }
          }
          if (!item) {
            console.warn('[tutorial-walkin] could not resolve character', pubkey)
            return
          }
          const payload = { ...item.addPayload, pos: seedPos, state: 'idle' }
          console.log('[tutorial-walkin] addAgent payload:', payload)
          const added = store.addAgent(payload)
          console.log('[tutorial-walkin] addAgent returned:', added)
        }
        console.log('[tutorial-walkin] post-update agents:',
          Object.values(store.getSnapshot().agents ?? {}).map((a) => ({ id: a.id, room: a.pos?.roomId })))
        console.log('[tutorial-walkin] handing off to stageWalkInAgent')
        await stageWalkInAgent({ pubkey, fromOffsetX, dx, ms })
        console.log('[tutorial-walkin] stageWalkInAgent resolved')
      },
      // Lets the runtime's `playStep` action chain to the next step
      // by id without spawning a new top-level play() (which would
      // bump the cancel token and abort the current run).
      findStep: (id) => (tutorialScripts.steps ?? []).find((s) => s.id === id) ?? null,
    })
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
                    {tutorialState.active && (
                      <span className="shelter-debug-hint">
                        running · step {tutorialState.actionIndex + 1}
                      </span>
                    )}
                  </h4>
                  <ul className="shelter-debug-tutorial">
                    {(tutorialScripts.steps ?? []).map((step) => {
                      const isRunning = tutorialState.active && tutorialState.stepId === step.id
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
                  {tutorialState.active && (
                    <button
                      type="button"
                      className="shelter-debug-tutorial-reset"
                      onClick={() => {
                        resetTutorial()
                        stageClearTutorialOverrides()
                        // Wipe non-NPC agents (the recruits the
                        // tutorial walks in / hires) so a fresh run
                        // doesn't see leftover store entries at stale
                        // rooms. NPCs (Edi etc.) stay.
                        const snap = store.getSnapshot()?.agents ?? {}
                        for (const [id, a] of Object.entries(snap)) {
                          if (a.kind !== 'npc') store.removeAgent(id)
                        }
                      }}
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

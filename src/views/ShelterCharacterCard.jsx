import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import config from '../config.js'
import { subscribe as subTutorial, getState as getTutorial } from '../lib/tutorial/runtime.js'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { levelForXp } from '../lib/shelterStore/index.js'
import { getRoomType } from '../lib/shelterWorld/roomTypes.js'
import { start as startAssignmentMode } from '../lib/shelterAssignmentMode.js'

const cfg = config.agentSandbox || {}

const SLOTS = ['morning', 'midday', 'afternoon', 'evening']
const SLOT_HOURS = {
  morning:   '06–11',
  midday:    '11–16',
  afternoon: '16–21',
  evening:   '21–06',
}
const SLOT_GLYPH = {
  morning:   '☀',
  midday:    '◐',
  afternoon: '◑',
  evening:   '☾',
}

/**
 * Profile card overlay for the focused shelter character.
 *
 * Tabbed: Profile (pic + name + bio) and Schedule (4-slot timetable).
 * Mirrors the agent-sandbox drawer aesthetic — ink-on-paper header,
 * hard 2px borders + 4px shadow, mono uppercase labels.
 *
 * Receives the shape produced by ShelterStage3D's onAgentFocusChange:
 *   { id, pubkey, name, avatarUrl } | null
 *
 * Bio (`about`) and schedule are fetched lazily from the bridge when
 * the agent has a pubkey. Resets on agent change so a fresh load can
 * retry an avatar that previously 404'd.
 */
export default function ShelterCharacterCard({ agent }) {
  const [tab, setTab] = useState('profile')
  const [imgFailed, setImgFailed] = useState(false)
  const [character, setCharacter] = useState(null)
  const [schedule, setSchedule] = useState(null)
  const [rooms, setRooms] = useState([])
  // Subscribe to the tutorial runtime's pulseTab so step 3 can
  // highlight the Assignment tab without prop-threading from Shelter.
  const tutorial = useSyncExternalStore(subTutorial, getTutorial)
  const pulseTab = tutorial.pulseTab ?? null

  // Live shelter snapshot for the active agent's manualAssignment +
  // the assigned room's production timer, plus the store API for the
  // setAssignment / clearAssignment mutations bound to the buttons.
  const shelterSnap = useShelterStore()
  const shelterApi = useShelterStoreApi()
  const liveAgent = (agent?.id && shelterSnap?.agents?.[agent.id]) || null
  const manualRoomId = liveAgent?.manualAssignment?.roomId ?? null
  const assignedRoom = manualRoomId ? shelterSnap?.rooms?.[manualRoomId] : null
  const assignedRoomType = manualRoomId ? getRoomType(manualRoomId) : null
  const xp = liveAgent?.xp ?? 0
  const level = levelForXp(xp)

  // Tab activation handler — when the player switches INTO the
  // Assignment tab from elsewhere AND the recruit isn't yet
  // assigned, auto-enter selection mode (no extra "Assign" button
  // step). Doesn't re-fire if the player taps the already-active
  // tab so cancels don't loop.
  const handleTabActivate = (id) => {
    setTab(id)
  }

  useEffect(() => { setImgFailed(false); setTab('profile') }, [agent?.id])

  // Fetch /characters/:pubkey → { name, about, ... } so we have the bio.
  // Also re-confirms name in case the registry was stale.
  useEffect(() => {
    if (!agent?.pubkey || !cfg.bridgeUrl) { setCharacter(null); return }
    let cancelled = false
    fetch(`${cfg.bridgeUrl}/characters/${agent.pubkey}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (!cancelled) setCharacter(c) })
      .catch(() => { if (!cancelled) setCharacter(null) })
    return () => { cancelled = true }
  }, [agent?.pubkey])

  // Schedule + rooms — only fetched when the user opens that tab,
  // since the bio path is the common case and avoiding extra latency
  // matters when the focus is just a quick glance.
  useEffect(() => {
    if (tab !== 'schedule' || !agent?.pubkey || !cfg.bridgeUrl) return
    let cancelled = false
    Promise.all([
      fetch(`${cfg.bridgeUrl}/schedules/${agent.pubkey}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${cfg.bridgeUrl}/rooms`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([s, r]) => {
      if (cancelled) return
      setSchedule(s ?? null)
      setRooms(Array.isArray(r?.rooms) ? r.rooms : Array.isArray(r) ? r : [])
    })
    return () => { cancelled = true }
  }, [tab, agent?.pubkey])

  const roomLabel = useMemo(() => {
    const map = new Map()
    for (const r of rooms ?? []) map.set(r.id ?? r.roomId, r.name ?? r.label ?? r.id)
    return (id) => (id == null ? '—' : map.get(id) ?? id)
  }, [rooms])

  if (!agent) return null

  const display = character?.name || agent.name || agent.id?.slice(0, 8) || '—'
  const initial = (display || '?').slice(0, 1).toUpperCase()
  const showImage = !!agent.avatarUrl && !imgFailed

  // Resolved per-slot schedule (effective = base + override). The
  // bridge response is `{ morning: { roomId, action } | null, ... }`
  // possibly with `override` and `base` keys; flatten to the merged
  // effective view.
  const effective = schedule?.effective ?? schedule
  const effSlot = (slot) => effective?.[slot] ?? null

  return (
    <aside className="shelter-card" role="status" aria-live="polite">
      <header className="shelter-card-head">
        <div className="shelter-card-avatar">
          {showImage ? (
            <img src={agent.avatarUrl} alt={display} onError={() => setImgFailed(true)} />
          ) : (
            <span>{initial}</span>
          )}
        </div>
        <div className="shelter-card-title">
          <strong>{display}</strong>
        </div>
      </header>

      <div className="shelter-card-body" role="tabpanel">
        {tab === 'profile' && (
          <AssignmentPanel
            agent={agent}
            manualRoomId={manualRoomId}
            assignedRoom={assignedRoom}
            assignedRoomType={assignedRoomType}
            xp={xp}
            level={level}
            onAssign={() => {
              if (!agent?.id) return
              startAssignmentMode(agent.id, ({ agentId, roomId }) => {
                shelterApi.setAssignment(agentId, roomId)
              })
            }}
          />
        )}
        {tab === 'schedule' && (
          <ul className="shelter-card-schedule">
            {SLOTS.map((slot) => {
              const s = effSlot(slot)
              return (
                <li key={slot} className="shelter-card-slot">
                  <span className="shelter-card-slot-glyph">{SLOT_GLYPH[slot]}</span>
                  <strong className="shelter-card-slot-name">{slot}</strong>
                  <span className="shelter-card-slot-hours">{SLOT_HOURS[slot]}</span>
                  <span className="shelter-card-slot-room">
                    {roomLabel(s?.roomId)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <nav className="shelter-card-tabs" role="tablist">
        <CardTab id="profile" tab={tab} setTab={handleTabActivate} pulseTab={pulseTab} title="Profile">
          <IconProfile /><span>Profile</span>
        </CardTab>
        <CardTab id="schedule" tab={tab} setTab={handleTabActivate} pulseTab={pulseTab} title="Schedule — daily timetable">
          <IconSchedule /><span>Schedule</span>
        </CardTab>
      </nav>
    </aside>
  )
}

/**
 * Tab button. Adds an `is-pulsing` class when the tutorial runtime
 * has marked this tab as the one to draw attention to (and the tab
 * isn't already active — once the player opens it, the highlight
 * stops on its own without needing the runtime to clear pulseTab).
 */
function CardTab({ id, tab, setTab, pulseTab, title, children }) {
  const isActive = tab === id
  const isPulsing = pulseTab === id && !isActive
  const cls = [
    'shelter-card-tab',
    isActive ? 'active' : '',
    isPulsing ? 'is-pulsing' : '',
  ].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      className={cls}
      onClick={() => setTab(id)}
      title={title}
    >
      {children}
    </button>
  )
}

function IconProfile() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4.5 5-6.5 8-6.5s6.5 2 8 6.5" />
    </svg>
  )
}

function IconSchedule() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
function AssignmentPanel({
  agent, manualRoomId, assignedRoom, assignedRoomType, xp, level,
  onAssign,
}) {
  if (!manualRoomId) {
    return (
      <div className="shelter-card-assignment">
        <p className="shelter-card-bio-empty">
          Tap a room to assign.
        </p>
        <button type="button" className="shelter-card-assign-btn" onClick={onAssign} disabled={!agent?.id}>
          Pick room
        </button>
      </div>
    )
  }
  const dur = Number(assignedRoomType?.productionDuration ?? 0)
  const timer = Number(assignedRoom?.productionTimer ?? 0)
  const ready = !!assignedRoom?.productionReady
  const pct = dur > 0 ? Math.min(100, Math.round((timer / dur) * 100)) : 0
  const reward = Number(assignedRoomType?.rewardCash ?? 0)
  return (
    <div className="shelter-card-assignment">
      <div className="shelter-card-assignment-row">
        <span className="shelter-card-assignment-label">Room</span>
        <strong className="shelter-card-assignment-room-name">
          {assignedRoomType?.name ?? manualRoomId}
        </strong>
        {/* Reassign sits inline so the row stays one line — no
            scrolling to find the action. Tapping it re-enters
            assignment-mode (same path the empty state uses) so the
            player picks a new room with one tap. */}
        <button
          type="button"
          className="shelter-card-reassign-btn"
          onClick={onAssign}
          title="Reassign"
        >
          Reassign
        </button>
      </div>
      <div className="shelter-card-assignment-row">
        <span className="shelter-card-assignment-label">Level</span>
        <strong>{level}</strong>
        <code className="shelter-card-assignment-xp">{xp} xp</code>
      </div>
      <div className={`shelter-card-progress${ready ? ' is-ready' : ''}`}>
        <div className="shelter-card-progress-fill" style={{ width: `${pct}%` }} />
        <span className="shelter-card-progress-label">
          {ready ? `Ready · ¤${reward}` : `${pct}%`}
        </span>
      </div>
    </div>
  )
}

function IconAssignment() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="1.5" />
      <path d="M9 9h6M9 13h6M9 17h4" />
    </svg>
  )
}

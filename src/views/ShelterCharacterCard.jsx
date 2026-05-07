import { useEffect, useMemo, useState } from 'react'
import config from '../config.js'

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
  const bio = character?.about?.trim() || ''

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
          {agent.pubkey && (
            <code title={agent.pubkey}>
              {agent.pubkey.slice(0, 8)}…
            </code>
          )}
        </div>
      </header>

      <div className="shelter-card-body" role="tabpanel">
        {tab === 'profile' && (
          <div className="shelter-card-profile">
            {bio
              ? <p className="shelter-card-bio">{bio}</p>
              : <p className="shelter-card-bio-empty">No bio yet.</p>}
          </div>
        )}
        {tab === 'schedule' && (
          <ul className="shelter-card-schedule">
            {SLOTS.map((slot) => {
              const s = effSlot(slot)
              return (
                <li key={slot} className="shelter-card-slot">
                  <span className="shelter-card-slot-glyph">{SLOT_GLYPH[slot]}</span>
                  <div className="shelter-card-slot-meta">
                    <strong>{slot}</strong>
                    <span className="shelter-card-slot-hours">{SLOT_HOURS[slot]}</span>
                  </div>
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
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'profile'}
          className={`shelter-card-tab${tab === 'profile' ? ' active' : ''}`}
          onClick={() => setTab('profile')}
          title="Profile"
        >
          <IconProfile />
          <span>Profile</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'schedule'}
          className={`shelter-card-tab${tab === 'schedule' ? ' active' : ''}`}
          onClick={() => setTab('schedule')}
          title="Schedule — daily timetable"
        >
          <IconSchedule />
          <span>Schedule</span>
        </button>
      </nav>
    </aside>
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

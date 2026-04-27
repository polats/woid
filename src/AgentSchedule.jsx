import { useEffect, useMemo, useState } from 'react'
import config from './config.js'

const cfg = config.agentSandbox || {}

/**
 * Agent schedule view — daily 4-slot timetable for one character.
 *
 * Read-only for now: shows what slot the character is currently in,
 * what room they should be heading to, and the resolved label of
 * each slot's target room. Resolution: "own" → owner's apartment.
 *
 * Polls /schedules/:pubkey every 4s and /agents to read current
 * position so we can flag whether the schedule is being followed
 * (`on schedule` / `routing` / `off schedule`).
 *
 * Editing comes later — the bridge already supports
 * PATCH /schedules/:pubkey { slot, room_id }.
 */

const SLOT_HOURS = {
  morning:   '06:00 – 11:00',
  midday:    '11:00 – 16:00',
  afternoon: '16:00 – 21:00',
  evening:   '21:00 – 06:00',
}

const SLOT_GLYPH = {
  morning:   '☀',
  midday:    '◐',
  afternoon: '◑',
  evening:   '☾',
}

function slotForHour(hour) {
  const h = ((hour % 24) + 24) % 24
  if (h >= 6  && h < 11) return 'morning'
  if (h >= 11 && h < 16) return 'midday'
  if (h >= 16 && h < 21) return 'afternoon'
  return 'evening'
}

export default function AgentSchedule({ pubkey }) {
  const [effective, setEffective] = useState(null)   // { morning, midday, afternoon, evening }
  const [override, setOverride] = useState(null)     // { ...partial }
  const [rooms, setRooms] = useState([])
  const [position, setPosition] = useState(null)     // { x, y, room_id }
  // Source of truth for the current slot is the bridge — bridge and
  // browser may disagree on timezone, and the schedule mover keys
  // off the bridge's clock anyway.
  const [bridgeSlot, setBridgeSlot] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!cfg.bridgeUrl || !pubkey) return
    let cancelled = false
    async function load() {
      try {
        const [s, r, ag, sh] = await Promise.all([
          fetch(`${cfg.bridgeUrl}/schedules/${pubkey}`).then((x) => x.json()),
          fetch(`${cfg.bridgeUrl}/rooms`).then((x) => x.json()),
          fetch(`${cfg.bridgeUrl}/agents`).then((x) => x.json()),
          fetch(`${cfg.bridgeUrl}/health/schedules`).then((x) => x.json()),
        ])
        if (cancelled) return
        setEffective(s.effective || null)
        const snap = await fetch(`${cfg.bridgeUrl}/schedules?pubkey=${pubkey}`).then((x) => x.json()).catch(() => null)
        const me = snap?.schedules?.[0]
        setOverride(me?.override || {})
        setRooms(r.rooms || [])
        const meAgent = (ag.agents || []).find((a) => a.npub === pubkey && a.running)
        setPosition(meAgent?.position || null)
        setBridgeSlot(sh?.slot || null)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(err.message || String(err))
      }
    }
    load()
    const t = setInterval(load, 4000)
    return () => { cancelled = true; clearInterval(t) }
  }, [pubkey])

  const roomById = useMemo(() => {
    const m = new Map()
    for (const r of rooms) m.set(r.id, r)
    return m
  }, [rooms])

  const ownRoom = useMemo(() => {
    return rooms.find((r) => r.owner_pubkey === pubkey) || null
  }, [rooms, pubkey])

  function resolveSlot(slot) {
    if (!effective) return null
    const target = effective[slot]
    if (!target) return null
    if (target === 'own') return ownRoom?.id || 'own'
    return target
  }

  // Prefer the bridge's slot (its clock drives the mover); fall back
  // to local-time slot derivation while the first poll is in flight.
  const currentSlot = bridgeSlot || slotForHour(new Date().getHours())

  // Status read for the current slot — does the character's actual
  // position match where the schedule says they should be?
  const currentTargetRoomId = resolveSlot(currentSlot)
  let routingStatus = 'unknown'
  if (position?.room_id && currentTargetRoomId) {
    if (position.room_id === currentTargetRoomId) routingStatus = 'on_schedule'
    else routingStatus = 'routing'  // mover should pick them up next tick
  } else if (!position) {
    routingStatus = 'not_running'
  }

  return (
    <div className="agent-schedule">
      <header className="agent-schedule-header">
        <strong>Daily schedule</strong>
        <span className={`agent-schedule-status status-${routingStatus}`}>
          {routingStatus === 'on_schedule' ? 'on schedule'
            : routingStatus === 'routing' ? 'heading to next slot'
            : routingStatus === 'not_running' ? 'not spawned'
            : 'unknown'}
        </span>
      </header>

      {error ? (
        <p className="muted" style={{ padding: 12 }}>schedule unavailable: {error}</p>
      ) : !effective ? (
        <p className="muted" style={{ padding: 12 }}>loading…</p>
      ) : (
        <ul className="agent-schedule-list">
          {['morning', 'midday', 'afternoon', 'evening'].map((slot) => {
            const targetId = resolveSlot(slot)
            const target = targetId ? roomById.get(targetId) : null
            const isCurrent = slot === currentSlot
            const isOverride = override && Object.prototype.hasOwnProperty.call(override, slot)
            return (
              <li
                key={slot}
                className={`agent-schedule-slot${isCurrent ? ' current' : ''}${isOverride ? ' overridden' : ''}`}
                data-slot={slot}
              >
                <span className="agent-schedule-glyph" aria-hidden>{SLOT_GLYPH[slot]}</span>
                <span className="agent-schedule-slot-name">{slot}</span>
                <span className="agent-schedule-hours">{SLOT_HOURS[slot]}</span>
                <span className="agent-schedule-arrow" aria-hidden>→</span>
                <span className="agent-schedule-target" title={target?.name || targetId}>
                  {target?.name || targetId || '—'}
                </span>
                {isOverride && <span className="agent-schedule-override-pill">override</span>}
              </li>
            )
          })}
        </ul>
      )}

      <footer className="agent-schedule-footer muted">
        {position ? (
          <span>currently in <strong>{position.room_id || `(${position.x}, ${position.y})`}</strong> · slot <strong>{currentSlot}</strong></span>
        ) : (
          <span>not spawned · slot <strong>{currentSlot}</strong></span>
        )}
      </footer>
    </div>
  )
}

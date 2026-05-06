import { useShelterStore } from '../hooks/useShelterStore.js'
import { SCHEDULES, formatSimTime } from '../lib/shelterStore/index.js'

/**
 * "Agents" tab content for the Shelter phone view. Lists every agent
 * in the local store with their current state and full daily
 * schedule. Read-only — adding / removing happens via the DEV menu.
 */
export default function ShelterAgentList() {
  const snapshot = useShelterStore()
  const agents = Object.values(snapshot?.agents ?? {})

  if (agents.length === 0) {
    return (
      <div className="shelter-agent-list-empty">
        <p>No agents in the shelter yet.</p>
        <p>Use the DEV menu on the Stage tab to add some.</p>
      </div>
    )
  }

  return (
    <div className="shelter-agent-list">
      {agents.map((a) => {
        const schedule = SCHEDULES[a.scheduleId] ?? SCHEDULES.worker
        const stateLabel = a.state === 'walking' && a.assignment?.roomId
          ? `walking → ${a.assignment.roomId}`
          : a.assignment?.roomId
            ? `${a.state} @ ${a.assignment.roomId}`
            : a.state
        return (
          <div key={a.id} className="shelter-agent-card">
            <div className="shelter-agent-card-head">
              <div className="shelter-agent-name">{a.name}</div>
              <div className="shelter-agent-state">{stateLabel}</div>
            </div>
            <div className="shelter-agent-meta">
              schedule: <span>{a.scheduleId}</span>
              {a.pubkey && <span className="shelter-agent-pubkey">· {a.pubkey.slice(0, 8)}</span>}
            </div>
            <ul className="shelter-agent-schedule">
              {schedule.map((slot, i) => (
                <li key={i}>
                  <span className="time">{formatSimTime(slot.from)}</span>
                  <span className="action">{slot.action}</span>
                  <span className="room">{slot.roomId}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

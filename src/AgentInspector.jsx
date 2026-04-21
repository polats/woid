import { useMemo, useState } from 'react'
import { useAgentEvents } from './hooks/useAgentEvents.js'

// Render a single pi event into a compact "thought / action / result" row.
// Handles the event types pi --mode json emits:
//   session, agent_start, turn_start, message_start, message_end,
//   message_update (thinking/text/tool_call deltas), tool_execution_{start,end},
//   turn_end, agent_end.
// Plus our own kinds: stdout, stderr, exit.

function extractAssistantText(msg) {
  const parts = Array.isArray(msg?.content) ? msg.content : []
  return parts.filter((p) => p?.type === 'text').map((p) => p.text || '').join('')
}
function extractThinking(msg) {
  const parts = Array.isArray(msg?.content) ? msg.content : []
  return parts.filter((p) => p?.type === 'thinking').map((p) => p.thinking || '').join('')
}

function EventRow({ ev }) {
  const { kind, data, text, code } = ev

  if (kind === 'stderr') {
    return <div className="ai-row ai-row-err"><span className="ai-label">stderr</span><pre>{text}</pre></div>
  }
  if (kind === 'stdout') {
    return <div className="ai-row ai-row-log"><span className="ai-label">stdout</span><pre>{text}</pre></div>
  }
  if (kind === 'exit') {
    return <div className="ai-row ai-row-exit">Process exited (code={code})</div>
  }
  if (kind !== 'pi' || !data?.type) return null

  switch (data.type) {
    case 'session':
      return <div className="ai-row ai-row-meta">session {data.id?.slice(0, 8)} @ {data.cwd}</div>
    case 'agent_start':
      return <div className="ai-row ai-row-meta">agent started</div>
    case 'agent_end':
      return <div className="ai-row ai-row-meta">agent ended</div>
    case 'turn_start':
      return <div className="ai-row ai-row-turn">— turn {data.turn ?? ''}</div>
    case 'turn_end':
      return null
    case 'message_end': {
      const msg = data.message
      if (!msg) return null
      if (msg.role === 'user') {
        return <div className="ai-row ai-row-user"><span className="ai-label">user</span><div>{extractAssistantText(msg)}</div></div>
      }
      if (msg.role === 'assistant') {
        const thinking = extractThinking(msg)
        const text = extractAssistantText(msg)
        return (
          <div className="ai-row ai-row-assistant">
            {thinking && (
              <details className="ai-thinking">
                <summary>thinking ({thinking.length} chars)</summary>
                <pre>{thinking}</pre>
              </details>
            )}
            {text && <div className="ai-text">{text}</div>}
          </div>
        )
      }
      if (msg.role === 'toolResult') {
        const payload = Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('') : ''
        return <div className="ai-row ai-row-tool-result">
          <span className="ai-label">{msg.toolName} result</span>
          <pre>{payload.slice(0, 2000)}</pre>
        </div>
      }
      return null
    }
    case 'tool_execution_start': {
      const preview = data.args?.command || JSON.stringify(data.args || {}).slice(0, 120)
      return <div className="ai-row ai-row-tool-call">
        <span className="ai-label">$ {data.toolName}</span>
        <pre>{preview}</pre>
      </div>
    }
    case 'tool_execution_end':
      // The corresponding message_end (role=toolResult) already renders the payload.
      return null
    case 'message_update':
      // Streaming deltas — skipped; we render the settled message_end.
      return null
    case 'message_start':
      return null
    default:
      return <div className="ai-row ai-row-unknown">{data.type}</div>
  }
}

export default function AgentInspector({ bridgeUrl, agent, onClose }) {
  const [showRaw, setShowRaw] = useState(false)
  const { events, status } = useAgentEvents({ bridgeUrl, agentId: agent?.agentId })

  const rendered = useMemo(() => {
    return events.map((ev, i) => <EventRow key={ev.seq ?? i} ev={ev} />).filter(Boolean)
  }, [events])

  if (!agent) return null

  return (
    <aside className="agent-inspector">
      <header>
        <div>
          <strong>{agent.name}</strong>
          {agent.model && (
            <span className="agent-model-badge" title={agent.model}>
              {agent.model.split('/').pop()}
            </span>
          )}
          <code title={agent.npub}>{agent.npub?.slice(0, 12)}…</code>
          <span className={`status status-${status}`}>{status}</span>
        </div>
        <div>
          <label className="ai-raw-toggle">
            <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} /> raw
          </label>
          <button onClick={onClose}>close</button>
        </div>
      </header>
      <div className="agent-inspector-body">
        {events.length === 0 && <p className="muted">Waiting for events…</p>}
        {showRaw
          ? <pre className="ai-raw">{events.map((e) => JSON.stringify(e)).join('\n')}</pre>
          : rendered}
      </div>
    </aside>
  )
}

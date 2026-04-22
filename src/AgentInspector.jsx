import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentEvents } from './hooks/useAgentEvents.js'
import AgentWaterfall from './AgentWaterfall.jsx'

// Walk pi events and pull the latest usage snapshot + counts of deltas.
// pi emits `usage: {input, output, totalTokens, cacheRead, cacheWrite}` on
// every message payload; streaming is signalled by `message_update` events.
function computeActivity(events) {
  let input = 0, output = 0, total = 0, cacheRead = 0, cacheWrite = 0
  let deltas = 0
  let toolCalls = 0
  let lastActivityTs = null
  for (const e of events) {
    if (e.kind !== 'pi' || !e.data) continue
    if (e.data.type === 'message_update') {
      deltas++
      lastActivityTs = e.ts
    }
    if (e.data.type === 'tool_execution_start') toolCalls++
    // Find usage on either the envelope's message or the update's partial.
    const msg = e.data.message || e.data.assistantMessageEvent?.partial
    const u = msg?.usage
    if (u) {
      if ((u.input ?? 0) > input) input = u.input
      if ((u.output ?? 0) > output) output = u.output
      if ((u.totalTokens ?? 0) > total) total = u.totalTokens
      if ((u.cacheRead ?? 0) > cacheRead) cacheRead = u.cacheRead
      if ((u.cacheWrite ?? 0) > cacheWrite) cacheWrite = u.cacheWrite
    }
  }
  return { input, output, total, cacheRead, cacheWrite, deltas, toolCalls, lastActivityTs }
}

// Flash briefly when a number goes up.
function useFlashOnChange(value) {
  const prev = useRef(value)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (value !== prev.current) {
      prev.current = value
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 400)
      return () => clearTimeout(t)
    }
  }, [value])
  return flash
}

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

export default function AgentInspector({ bridgeUrl, agent, view = 'context' }) {
  const [showRaw, setShowRaw] = useState(false)
  // Only stream SSE when the Live tab is actually showing — avoids
  // holding an EventSource open while the user is on Context.
  const { events, status } = useAgentEvents({
    bridgeUrl,
    agentId: agent?.agentId,
    enabled: view === 'live',
  })

  const rendered = useMemo(() => {
    return events.map((ev, i) => <EventRow key={ev.seq ?? i} ev={ev} />).filter(Boolean)
  }, [events])

  const activity = useMemo(() => computeActivity(events), [events])
  const flashTotal = useFlashOnChange(activity.total)
  const flashDeltas = useFlashOnChange(activity.deltas)
  const isLive = agent?.running && (Date.now() - (activity.lastActivityTs ?? 0) < 3000)

  if (!agent) return null

  if (view === 'context') {
    return (
      <div className="agent-inspector">
        <div className="agent-inspector-body">
          <AgentWaterfall
            bridgeUrl={bridgeUrl}
            pubkey={agent.npub}
            model={agent.model}
            currentModel={agent.model}
          />
        </div>
      </div>
    )
  }

  // view === 'live'
  return (
    <div className="agent-inspector">
      <div className="agent-inspector-activity">
        <span className={`ai-stat${flashTotal ? ' flash' : ''}`} title={`input ${activity.input} · output ${activity.output}`}>
          <span className="ai-stat-label">tokens</span>
          <strong>{activity.total.toLocaleString()}</strong>
          <span className="muted">↑{activity.output.toLocaleString()} ↓{activity.input.toLocaleString()}</span>
        </span>
        <span className={`ai-stat${flashDeltas ? ' flash' : ''}`}>
          <span className="ai-stat-label">deltas</span>
          <strong>{activity.deltas}</strong>
        </span>
        <span className="ai-stat">
          <span className="ai-stat-label">tools</span>
          <strong>{activity.toolCalls}</strong>
        </span>
        <span className={`status status-${status}`} style={{ marginLeft: 'auto' }}>{status}</span>
        {isLive && <span className="ai-pulse" title="streaming…">●</span>}
        <label className="ai-raw-toggle">
          <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} /> raw
        </label>
      </div>
      <div className="agent-inspector-body">
        {events.length === 0 && <p className="muted">Waiting for events…</p>}
        {showRaw
          ? <pre className="ai-raw">{events.map((e) => JSON.stringify(e)).join('\n')}</pre>
          : rendered}
      </div>
    </div>
  )
}

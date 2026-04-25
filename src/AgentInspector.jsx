import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentEvents } from './hooks/useAgentEvents.js'
import AgentWaterfall from './AgentWaterfall.jsx'

// Walk events and pull the latest usage snapshot + activity counts.
// Handles two event shapes:
//   * pi (kind='pi', data is one of pi's RPC events). Usage lives on
//     `message.usage` or `assistantMessageEvent.partial.usage`. Streaming
//     deltas come as `message_update` events; tool calls as
//     `tool_execution_start`.
//   * direct / external (kind='turn_start'|'action'|'think'|'turn_end').
//     Usage lives on `turn_end.data.usage` (summed across the turn);
//     "actions" map to tool calls; "think" / "action" / "turn_*" are
//     each one delta tick.
function computeActivity(events) {
  let input = 0, output = 0, total = 0, cacheRead = 0, cacheWrite = 0
  let deltas = 0
  let toolCalls = 0
  let lastActivityTs = null
  for (const e of events) {
    if (!e || !e.kind) continue

    if (e.kind === 'pi' && e.data) {
      if (e.data.type === 'message_update') {
        deltas++
        lastActivityTs = e.ts
      }
      if (e.data.type === 'tool_execution_start') toolCalls++
      const msg = e.data.message || e.data.assistantMessageEvent?.partial
      const u = msg?.usage
      if (u) {
        if ((u.input ?? 0) > input) input = u.input
        if ((u.output ?? 0) > output) output = u.output
        if ((u.totalTokens ?? 0) > total) total = u.totalTokens
        if ((u.cacheRead ?? 0) > cacheRead) cacheRead = u.cacheRead
        if ((u.cacheWrite ?? 0) > cacheWrite) cacheWrite = u.cacheWrite
      }
      continue
    }

    // Non-pi (direct / external / pool) harness events.
    if (e.kind === 'action') {
      toolCalls++
      deltas++
      lastActivityTs = e.ts
      continue
    }
    if (e.kind === 'think' || e.kind === 'turn_start' || e.kind === 'turn_end') {
      deltas++
      lastActivityTs = e.ts
    }
    if (e.kind === 'turn_end') {
      const u = e.data?.usage
      if (u) {
        // Direct usage is per-turn, not cumulative — accumulate.
        input += (u.input ?? 0)
        output += (u.output ?? 0)
        total += (u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0))
      }
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

// Map either action shape to { verb, args }. The bridge emits the new
// shape from #225 slice 2 onward; older session logs may still contain
// the legacy { type, ...flat } form.
function normaliseAction(a) {
  if (a && typeof a.verb === 'string' && a.args && typeof a.args === 'object') {
    return { verb: a.verb, args: a.args }
  }
  if (!a || typeof a.type !== 'string') return { verb: '?', args: {} }
  switch (a.type) {
    case 'say':     return { verb: 'say',     args: { text: a.text } }
    case 'say_to':  return { verb: 'say_to',  args: { recipient: a.recipient, text: a.text } }
    case 'move':    return { verb: 'move',    args: { x: a.x, y: a.y } }
    case 'face':    return { verb: 'face',    args: { target: a.target } }
    case 'wait':    return { verb: 'wait',    args: { seconds: a.seconds } }
    case 'emote':   return { verb: 'emote',   args: { kind: a.kind } }
    case 'state':   return { verb: 'set_state', args: { value: a.value } }
    case 'mood':    return { verb: 'set_mood', args: a.value || {} }
    case 'post':    return { verb: 'post',    args: { text: a.text } }
    case 'idle':    return { verb: 'idle',    args: {} }
    default:        return { verb: a.type,    args: a }
  }
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

  // Direct / external harness events. These are emitted with kind set
  // directly (not nested under 'pi'). Render them with the same row
  // shapes the pi cases use so the Live tab feels uniform.
  if (kind === 'turn_start') {
    return <div className="ai-row ai-row-turn">— turn {data?.turn ?? ''} ({data?.harness ?? ''})</div>
  }
  if (kind === 'turn_end') {
    const u = data?.usage
    if (!u) return null
    return (
      <div className="ai-row ai-row-meta">
        turn {data?.turn ?? ''} done · in {u.input ?? 0} · out {u.output ?? 0} · total {u.totalTokens ?? ''}
      </div>
    )
  }
  if (kind === 'think') {
    const text = typeof data === 'string' ? data : (data?.thinking || '')
    if (!text) return null
    return (
      <div className="ai-row ai-row-assistant">
        <details className="ai-thinking">
          <summary>thinking ({text.length} chars)</summary>
          <pre>{text}</pre>
        </details>
      </div>
    )
  }
  if (kind === 'action') {
    const { verb, args } = normaliseAction(data || {})
    if (verb === 'say') {
      return (
        <div className="ai-row ai-row-assistant">
          <span className="ai-label">say</span>
          <div className="ai-text">{args.text}</div>
        </div>
      )
    }
    if (verb === 'say_to') {
      return (
        <div className="ai-row ai-row-assistant">
          <span className="ai-label">say → {args.recipient}</span>
          <div className="ai-text">{args.text}</div>
        </div>
      )
    }
    if (verb === 'post') {
      return (
        <div className="ai-row ai-row-post">
          <span className="ai-label">post</span>
          <div className="ai-text">{args.text}</div>
        </div>
      )
    }
    if (verb === 'move') {
      return <div className="ai-row ai-row-tool-call"><span className="ai-label">move</span><pre>{`(${args.x}, ${args.y})`}</pre></div>
    }
    if (verb === 'face') {
      return <div className="ai-row ai-row-tool-call"><span className="ai-label">face</span><pre>{args.target}</pre></div>
    }
    if (verb === 'wait') {
      return <div className="ai-row ai-row-meta">wait{args.seconds != null ? ` (${args.seconds}s)` : ''}</div>
    }
    if (verb === 'emote') {
      return <div className="ai-row ai-row-tool-call"><span className="ai-label">emote</span><pre>{args.kind}</pre></div>
    }
    if (verb === 'idle') {
      return <div className="ai-row ai-row-meta">idle</div>
    }
    if (verb === 'set_state' || verb === 'state') {
      return <div className="ai-row ai-row-tool-call"><span className="ai-label">state</span><pre>{args.value ?? args.text}</pre></div>
    }
    if (verb === 'set_mood' || verb === 'mood') {
      const mood = verb === 'mood' ? args.value : args
      const parts = []
      if (mood?.energy != null) parts.push(`energy ${mood.energy}`)
      if (mood?.social != null) parts.push(`social ${mood.social}`)
      return <div className="ai-row ai-row-tool-call"><span className="ai-label">mood</span><pre>{parts.join(' · ')}</pre></div>
    }
    return <div className="ai-row ai-row-unknown">action: {verb}</div>
  }
  if (kind === 'error' || kind === 'turn-error' || kind === 'action-error') {
    const msg = data?.message || data?.error || JSON.stringify(data || {}).slice(0, 200)
    return <div className="ai-row ai-row-err"><span className="ai-label">{kind}</span><pre>{msg}</pre></div>
  }
  if (kind === 'rate-limit' || kind === 'rate-limit-deferred') {
    return <div className="ai-row ai-row-meta">{kind} · {data?.provider || ''}{data?.remainingMs ? ` · ${Math.round(data.remainingMs / 1000)}s` : ''}</div>
  }
  if (kind === 'pool:spawn' || kind === 'pool:exit' || kind === 'pool:crashed') {
    return <div className="ai-row ai-row-meta">{kind} {data?.code ?? data?.pid ?? ''}</div>
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

/**
 * Inspector "Turns" mode — reads per-character turns from pi's session
 * JSONL via the bridge, renders a waterfall lifted from
 * call-my-agent's InteractionWaterfallPanel. Section parsing + colors
 * match that file so logic ports cleanly.
 */
import { useMemo, useState } from 'react'
import { useAgentTurns } from './hooks/useAgentTurns.js'

const SECTION_MAP = [
  ['Trigger:',               'Trigger'],
  ['You are ',               'Identity'],
  ['This is who you are',    'Identity'],
  ['Where your head is',     'Current State'],
  ['Your current state:',    'Current State'],
  ['You are at (',           'Situation'],
  ['Also on your tile',      'Nearby'],
  ['Others in the room',     'Roster'],
  ['New in the room',        'New messages'],
  ['Recent chat:',           'Recent chat'],
  ['Storyteller cues',       'Storyteller'],
  ['Recent events:',         'Recent events'],
  ['Your recent actions',    'Recent Actions'],
  ['Tools available',        'Tool Manual'],
  ['Read .pi/skills',        'Tool Manual'],
  ['Keep posts short',       'Tool Manual'],
  ['The room is a ',         'Situation'],
]

const SECTION_COLORS = {
  'Global Prompt':   'var(--violet)',
  'Trigger':         'var(--amber)',
  'Identity':        'var(--prussian)',
  'Current State':   'var(--transmit)',
  'Situation':       'var(--prussian)',
  'Nearby':          'var(--ok-ink)',
  'Roster':          'var(--violet)',
  'New messages':    'var(--prussian)',
  'Recent chat':     'var(--prussian)',
  'Storyteller':     'var(--violet)',
  'Recent events':   'var(--ok-ink)',
  'Recent Actions':  'var(--amber)',
  'Tool Manual':     'var(--ink-muted)',
}

function parsePromptSections(prompt) {
  const lines = prompt.split('\n')
  const sections = []
  let current = null
  for (const line of lines) {
    const trimmed = line.trim()
    let matched = null
    for (const [prefix, label] of SECTION_MAP) {
      if (trimmed.startsWith(prefix)) { matched = label; break }
    }
    if (matched) {
      if (current && current.content.trim()) sections.push(current)
      current = { label: matched, content: line + '\n', chars: 0 }
    } else if (current) {
      current.content += line + '\n'
    } else if (trimmed) {
      current = { label: 'Global Prompt', content: line + '\n', chars: 0 }
    }
  }
  if (current && current.content.trim()) sections.push(current)
  // Collapse repeated labels (e.g. two Tool Manual blocks) into one.
  const collapsed = []
  for (const s of sections) {
    const prev = collapsed[collapsed.length - 1]
    if (prev && prev.label === s.label) prev.content += s.content
    else collapsed.push({ ...s })
  }
  for (const s of collapsed) s.chars = s.content.trim().length
  return collapsed
}

function SectionCard({ section }) {
  const [open, setOpen] = useState(false)
  const color = SECTION_COLORS[section.label] ?? 'var(--ink-muted)'
  return (
    <div className="wf-section" style={{ borderColor: color }}>
      <button onClick={() => setOpen(!open)} className="wf-section-head">
        <span className="wf-section-caret" style={{ color }}>{open ? '▼' : '▶'}</span>
        <span className="wf-section-label" style={{ color }}>{section.label}</span>
        <span className="wf-section-size">{section.chars} chars</span>
      </button>
      {open && <pre className="wf-section-body">{section.content}</pre>}
    </div>
  )
}

function TokenBudgetBar({ sections, totalTokens, contextWindow }) {
  const contentSections = sections.filter((s) => s.label !== 'Tool Manual')
  const contentChars = contentSections.reduce((sum, s) => sum + s.chars, 0) || 1
  const totalChars = sections.reduce((sum, s) => sum + s.chars, 0)
  const estTokens = Math.round(totalChars / 4)
  const effectiveTokens = totalTokens || estTokens
  const pct = Math.min(100, (effectiveTokens / contextWindow) * 100)
  const level = pct > 80 ? 'red' : pct > 50 ? 'amber' : 'green'
  return (
    <div className={`wf-budget level-${level}`}>
      <div className="wf-budget-stats">
        <div><small>Context</small>
          <strong>{effectiveTokens.toLocaleString()} / {contextWindow.toLocaleString()}</strong>
          <span className="muted">{pct.toFixed(1)}%</span>
        </div>
        {totalTokens && estTokens !== totalTokens && (
          <div className="muted"><small>prompt estimate</small><strong>~{estTokens.toLocaleString()}</strong></div>
        )}
      </div>
      <div className="wf-budget-bar">
        {contentSections.map((s, i) => {
          const p = (s.chars / contentChars) * 100
          const color = SECTION_COLORS[s.label] ?? 'var(--ink-muted)'
          return (
            <div key={i} className="wf-budget-seg"
                 style={{ width: `${Math.max(p, 0.5)}%`, background: color }}
                 title={`${s.label}: ${s.chars} chars (${p.toFixed(1)}%)`} />
          )
        })}
      </div>
      <div className="wf-budget-legend">
        {contentSections.map((s, i) => (
          <span key={i} className="wf-budget-key">
            <span className="wf-budget-swatch" style={{ background: SECTION_COLORS[s.label] ?? 'var(--ink-muted)' }} />
            {s.label} · {((s.chars / contentChars) * 100).toFixed(0)}%
          </span>
        ))}
      </div>
    </div>
  )
}

function Waterfall({ turn, fallbackModel, contextWindow }) {
  if (turn.isCompaction) {
    return (
      <div className="wf-empty">
        <strong>💾 compacted</strong>
        <div className="muted">
          {turn.tokensBefore ? `${turn.tokensBefore.toLocaleString()} tokens before` : ''}
        </div>
        {turn.summary && <pre className="wf-section-body">{turn.summary}</pre>}
      </div>
    )
  }
  const sections = parsePromptSections(turn.user?.text ?? '')
  return (
    <div className="wf">
      <div className="wf-stage">
        <div className="wf-stage-head"><span className="wf-stage-icon" style={{ background: 'var(--amber)' }}>1</span>Trigger</div>
        <div className="wf-kv">
          <div><small>Trigger</small><strong>{extractTriggerText(turn.user?.text) || '—'}</strong></div>
          <div>
            <small>When</small>
            <code>{new Date(turn.startedAt).toLocaleTimeString()}</code>
            {extractSimTime(turn.user?.text) && (
              <code className="muted wf-when-sim">{extractSimTime(turn.user?.text)}</code>
            )}
          </div>
          <div><small>Duration</small><code>{turn.durationMs ? `${(turn.durationMs/1000).toFixed(1)}s` : '—'}</code></div>
        </div>
      </div>

      <div className="wf-arrow">↓</div>

      <div className="wf-stage">
        <div className="wf-stage-head"><span className="wf-stage-icon" style={{ background: 'var(--prussian)' }}>2</span>Context Assembly</div>
        <TokenBudgetBar
          sections={sections}
          totalTokens={turn.usage?.totalTokens ?? 0}
          contextWindow={contextWindow}
        />
        <div className="wf-sections">
          {sections.map((s, i) => <SectionCard key={i} section={s} />)}
        </div>
      </div>

      <div className="wf-arrow">↓</div>

      <div className="wf-stage">
        <div className="wf-stage-head"><span className="wf-stage-icon" style={{ background: 'var(--transmit)' }}>3</span>Assistant</div>
        {turn.assistant?.thinking && (
          <details className="wf-thinking">
            <summary>thinking ({turn.assistant.thinking.length} chars)</summary>
            <pre>{turn.assistant.thinking}</pre>
          </details>
        )}
        {turn.assistant?.text ? (
          <div className="wf-assistant-text">{turn.assistant.text}</div>
        ) : <div className="muted">(no text output)</div>}
        {turn.usage && (
          <div className="wf-usage">
            <small>Used</small>
            <code>{turn.usage.totalTokens?.toLocaleString()} tokens</code>
            <span className="muted">↑{turn.usage.output ?? 0} ↓{turn.usage.input ?? 0}</span>
            <small>Model</small>
            <code>{turn.model || fallbackModel || '?'}</code>
          </div>
        )}
      </div>

      {(turn.toolResults?.length > 0) && (<>
        <div className="wf-arrow">↓</div>
        <div className="wf-stage">
          <div className="wf-stage-head"><span className="wf-stage-icon" style={{ background: 'var(--ok-ink)' }}>4</span>Tools · {turn.toolResults.length}</div>
          {turn.toolResults.map((t, i) => (
            <div key={i} className={`wf-tool${t.isError ? ' error' : ''}`}>
              <div className="wf-tool-head"><code>{t.toolName}</code></div>
              <pre>{(t.text ?? '').slice(0, 600)}</pre>
            </div>
          ))}
        </div>
      </>)}

      {turn.compactions?.length > 0 && (<>
        <div className="wf-arrow">↓</div>
        <div className="wf-stage wf-compaction">
          <div className="wf-stage-head"><span className="wf-stage-icon" style={{ background: 'var(--violet)' }}>💾</span>Compaction</div>
          {turn.compactions.map((c, i) => (
            <div key={i}><small>{c.tokensBefore?.toLocaleString()} tokens compacted</small><pre>{c.summary}</pre></div>
          ))}
        </div>
      </>)}
    </div>
  )
}

// `currentModel` is the runtime's live model id (accurate right now);
// `model` is the legacy fallback. `meta.model` from the session JSONL is
// frozen at the first model_change event and can be stale.
export default function AgentWaterfall({ bridgeUrl, pubkey, model, currentModel }) {
  const { turns, meta, status } = useAgentTurns({ bridgeUrl, pubkey })
  const [selectedId, setSelectedId] = useState(null)
  const selected = useMemo(() => {
    if (!turns.length) return null
    return turns.find((t) => t.turnId === selectedId) ?? turns[0]
  }, [turns, selectedId])

  // Pi models ship with 131072 as their standard context window; we read
  // it from `/models` later to swap per model. For now, use a constant.
  const contextWindow = 131072

  if (status === 'error') {
    return <p className="muted wf-empty">Failed to read turns.</p>
  }
  if (!turns.length) {
    return (
      <p className="muted wf-empty">
        {status === 'ready'
          ? 'No turns yet. Spawn the agent to start a conversation.'
          : 'Loading…'}
      </p>
    )
  }

  return (
    <div className="wf-layout">
      <aside className="wf-picker">
        <ul>
          {turns.map((t, i) => (
            <li
              key={t.turnId}
              className={`wf-picker-item${(selected?.turnId ?? null) === t.turnId ? ' selected' : ''}${t.isCompaction ? ' compaction' : ''}`}
              onClick={() => setSelectedId(t.turnId)}
            >
              <div className="wf-picker-head">
                <strong>#{turns.length - i}</strong>
                <code>{t.isCompaction ? 'compacted' : extractTriggerKind(t.user?.text)}</code>
              </div>
              <div className="wf-picker-meta">
                <small>{new Date(t.startedAt).toLocaleTimeString()}</small>
                {t.usage?.totalTokens != null && <small>· {t.usage.totalTokens.toLocaleString()} tok</small>}
                {t.toolResults?.length > 0 && <small>· {t.toolResults.length} tools</small>}
              </div>
            </li>
          ))}
        </ul>
      </aside>
      <div className="wf-main">
        {selected && (
          <Waterfall
            turn={selected}
            fallbackModel={currentModel || model || meta.model}
            contextWindow={contextWindow}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Extract just the Trigger line (one-liner under "Trigger: ...").
 * The user-turn prompt may also include `When:` and other lines that
 * the Trigger section parser sweeps in; we only want the trigger
 * sentence itself for the inspector card.
 */
function extractTriggerText(text = '') {
  const m = text.match(/^Trigger:\s*([^\n]+)/m)
  return m ? m[1].trim().slice(0, 120) : ''
}

/**
 * Pull the sim-time portion out of the prompt's `When:` line.
 * Format set by buildContext.formatRealClock + simNow:
 *   When: 2026-04-26 21:46 UTC (real) · Day 11 · 09:14 morning (sim)
 * Returns "Day 11 · 09:14 morning" or "" if not present.
 */
function extractSimTime(text = '') {
  const m = text.match(/^When:[^\n]*?·\s*([^\n]+?)\s*\(sim\)/m)
  return m ? m[1].trim() : ''
}

function extractTriggerKind(text = '') {
  const m = text.match(/^Trigger:\s*([^\n]+)/)
  if (!m) return '?'
  const line = m[1].toLowerCase()
  if (line.includes('stepped into')) return 'spawn'
  if (line.includes('received a message')) return 'message'
  if (line.includes('arrived')) return 'arrival'
  if (line.includes('left the room')) return 'departure'
  if (line.includes('moment has passed')) return 'heartbeat'
  if (line.includes('gone quiet')) return 'idle'
  if (line.includes('asked you to summarize')) return 'compact'
  return m[1].slice(0, 16)
}

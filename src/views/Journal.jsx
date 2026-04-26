import { useEffect, useState, useCallback, useMemo } from 'react'
import config from '../config.js'

const PAGE = 50

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

function fmtDuration(start, end) {
  if (!start || !end) return ''
  const s = Math.max(0, Math.round((end - start) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m${r}s` : `${m}m`
}

function shortPub(p) {
  return typeof p === 'string' ? p.slice(0, 8) : '?'
}

const REASON_LABELS = {
  budget: 'ended naturally',
  soft_stop: 'wound down quietly',
  hard_cap: 'ran long',
  proximity_lost: 'parted ways',
}

/**
 * Journal — chronological log of every closed scene. Each card
 * collapses to participants + summary; expand to read the full
 * play-script transcript pulled from the bridge.
 */
export default function Journal() {
  const bridgeUrl = config.agentSandbox?.bridgeUrl
  const [scenes, setScenes] = useState([])
  const [characters, setCharacters] = useState([])
  const [participantFilter, setParticipantFilter] = useState('')
  const [loadErr, setLoadErr] = useState(null)
  const [expandedIds, setExpandedIds] = useState(new Set())

  // Map pubkey → display name, so transcripts and roster don't show
  // raw 64-char hex strings.
  const pubkeyToName = useMemo(() => {
    const m = new Map()
    if (Array.isArray(characters)) {
      for (const c of characters) if (c?.pubkey) m.set(c.pubkey, c.name)
    }
    return m
  }, [characters])

  const refresh = useCallback(async () => {
    if (!bridgeUrl) return
    const params = new URLSearchParams({ limit: String(PAGE) })
    if (participantFilter) params.set('participant', participantFilter)
    try {
      const r = await fetch(`${bridgeUrl}/scenes?${params}`)
      if (!r.ok) throw new Error(String(r.status))
      const json = await r.json()
      setScenes(json.scenes || [])
      setLoadErr(null)
    } catch (e) {
      setLoadErr(e.message || String(e))
    }
  }, [bridgeUrl, participantFilter])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!bridgeUrl) return
    fetch(`${bridgeUrl}/characters`)
      .then((r) => r.ok ? r.json() : { characters: [] })
      .then((j) => setCharacters(Array.isArray(j) ? j : (j?.characters || [])))
      .catch(() => setCharacters([]))
  }, [bridgeUrl])

  // Light auto-refresh so newly-closed scenes appear without a manual click.
  useEffect(() => {
    if (!bridgeUrl) return
    const t = setInterval(() => refresh(), 8000)
    return () => clearInterval(t)
  }, [bridgeUrl, refresh])

  function toggle(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className="journal-view">
      <header>
        <h1>Journal</h1>
        <div className="journal-meta">
          <span className="muted">{scenes.length} scenes</span>
          <select
            value={participantFilter}
            onChange={(e) => setParticipantFilter(e.target.value)}
            aria-label="Filter by participant"
          >
            <option value="">All participants</option>
            {characters.map((c) => (
              <option key={c.pubkey} value={c.pubkey}>{c.name}</option>
            ))}
          </select>
          <button onClick={refresh}>Refresh</button>
        </div>
      </header>

      {loadErr && <p className="journal-err">Failed to load: {loadErr}</p>}

      {scenes.length === 0 ? (
        <p className="muted">No scenes yet. Bring two characters within 3 tiles to start one.</p>
      ) : (
        <ul className="journal-list">
          {scenes.map((s) => {
            const expanded = expandedIds.has(s.scene_id)
            const reason = REASON_LABELS[s.end_reason] || s.end_reason || '?'
            const turnCount = s.turns?.length ?? 0
            const names = (s.participants || []).map((p) => pubkeyToName.get(p) || shortPub(p))
            return (
              <li key={s.scene_id} className={`journal-card${expanded ? ' expanded' : ''}`}>
                <button
                  className="journal-card-head"
                  onClick={() => toggle(s.scene_id)}
                  aria-expanded={expanded}
                >
                  <div className="journal-card-row">
                    <strong>{names.join(' · ')}</strong>
                    <span className={`journal-reason reason-${s.end_reason}`}>{reason}</span>
                  </div>
                  <div className="journal-card-row sub">
                    <span className="muted">
                      {fmtTime(s.ts_start)}{s.ts_end ? ` → ${fmtTime(s.ts_end)} (${fmtDuration(s.ts_start, s.ts_end)})` : ''}
                    </span>
                    <span className="muted">{turnCount} turns</span>
                  </div>
                </button>
                {expanded && (
                  <div className="journal-transcript">
                    {turnCount === 0
                      ? <p className="muted">No turns recorded.</p>
                      : (s.turns || []).map((t, i) => (
                          <TranscriptLine key={i} turn={t} pubkeyToName={pubkeyToName} />
                        ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function TranscriptLine({ turn, pubkeyToName }) {
  const who = pubkeyToName.get(turn.actor_pubkey) || turn.actor_name || shortPub(turn.actor_pubkey)
  const args = turn.args || {}
  switch (turn.verb) {
    case 'say':
      return <div className="journal-turn turn-say"><span className="who">{who}</span><span className="text">"{args.text}"</span></div>
    case 'say_to': {
      const to = pubkeyToName.get(args.recipient) || args.recipient || '?'
      return <div className="journal-turn turn-say"><span className="who">{who} → {to}</span><span className="text">"{args.text}"</span></div>
    }
    case 'post':
      return <div className="journal-turn turn-post"><span className="who">{who} posted</span><span className="text">"{args.text}"</span></div>
    case 'move':
      return <div className="journal-turn turn-meta"><span className="who">{who}</span><span className="text muted">moved to ({args.x}, {args.y})</span></div>
    case 'face':
      return <div className="journal-turn turn-meta"><span className="who">{who}</span><span className="text muted">turned toward {args.target}</span></div>
    case 'wait':
      return <div className="journal-turn turn-meta"><span className="who">{who}</span><span className="text muted">waited{args.seconds != null ? ` (${args.seconds}s)` : ''}</span></div>
    case 'emote':
      return <div className="journal-turn turn-meta"><span className="who">{who}</span><span className="text muted">{args.kind}</span></div>
    case 'set_state':
      return <div className="journal-turn turn-meta"><span className="who">{who}</span><span className="text muted">(state: "{args.value}")</span></div>
    case 'set_mood':
      return <div className="journal-turn turn-meta"><span className="who">{who}</span><span className="text muted">(mood {Object.entries(args).map(([k, v]) => `${k} ${v}`).join(', ')})</span></div>
    case 'idle':
      return <div className="journal-turn turn-meta"><span className="who">{who}</span><span className="text muted">idle</span></div>
    default:
      return <div className="journal-turn turn-meta"><span className="who">{who}</span><span className="text muted">{turn.verb}</span></div>
  }
}

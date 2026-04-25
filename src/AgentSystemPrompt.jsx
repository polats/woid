import { useEffect, useState } from 'react'

/**
 * Renders the system prompt the bridge will pass to this character's
 * harness on the next turn. Fetches from
 * `GET /characters/:pubkey/system-prompt`, which builds it fresh
 * server-side using the character's about/state and the chosen
 * harness's variant. Direct + external also get a per-harness OUTPUT
 * CONTRACT appended internally that's not part of this string.
 */
export default function AgentSystemPrompt({ bridgeUrl, pubkey }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!bridgeUrl || !pubkey) return
    let cancelled = false
    fetch(`${bridgeUrl}/characters/${pubkey}/system-prompt`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => { if (!cancelled) setData(d) })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)) })
    return () => { cancelled = true }
  }, [bridgeUrl, pubkey])

  if (error) return <p className="agent-profile-error" style={{ margin: 14 }}>{error}</p>
  if (!data) return <p className="muted" style={{ padding: 14 }}>Loading system prompt…</p>

  function copy() {
    try { navigator.clipboard?.writeText(data.systemPrompt) } catch {}
  }

  return (
    <div className="agent-system">
      <div className="agent-system-meta">
        <span className="agent-system-pill">{data.harness}</span>
        <span className="muted">room {data.roomWidth}×{data.roomHeight}</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={copy} className="agent-system-copy">copy</button>
      </div>
      <pre className="agent-system-prompt">{data.systemPrompt}</pre>
      {data.note && <p className="muted agent-system-note">{data.note}</p>}
    </div>
  )
}

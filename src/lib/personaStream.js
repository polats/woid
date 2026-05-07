/**
 * Shared helpers for the bridge's persona-generation stream.
 *
 * Both AgentProfile (player characters) and NPCs use the same SSE
 * endpoint and the same partial-JSON extraction trick to live-update
 * a name + about input as the stream arrives. Keeping the consumer
 * here means there's a single place to evolve the protocol — events
 * the bridge emits today (`model`, `delta`, `persona-done`,
 * `avatar-start/done/error`, `done`, `error`) and any future ones.
 */

/**
 * Best-effort partial-JSON extraction so we can stream growing fields
 * back into the form before the closing `"` or `}` lands. Pulls the
 * value of the named key, treating an unterminated string as
 * "everything after the key marker up to EOL".
 *
 * Bounded outputs (name 80 chars, about 1000 chars) match the bridge's
 * own caps so we don't overshoot the field on partial reads.
 */
export function extractLivePersona(raw) {
  if (!raw) return { name: '', about: '' }
  function pull(key) {
    const closed = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    if (closed) return closed[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
    const open = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`))
    if (open) return open[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
    return ''
  }
  return {
    name: pull('name').slice(0, 80),
    about: pull('about').slice(0, 1000),
  }
}

/**
 * POST /characters/:pubkey/generate-profile/stream and dispatch each
 * SSE event to `onEvent(eventType, parsed, raw)`. Resolves when the
 * stream ends; throws if the response isn't OK or if an `error`
 * event arrives.
 *
 * `body` is the JSON payload — typically `{ seed, overwriteName, skipAvatar }`.
 * `signal` is an optional AbortSignal so the caller can cancel.
 */
export async function streamGenerateProfile({ bridgeUrl, pubkey, body, onEvent, signal }) {
  const res = await fetch(`${bridgeUrl}/characters/${pubkey}/generate-profile/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const events = buf.split(/\n\n/)
    buf = events.pop() ?? ''
    for (const evChunk of events) {
      const lines = evChunk.split('\n')
      let evt = 'message'
      const dataLines = []
      for (const line of lines) {
        if (line.startsWith('event:')) evt = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      const data = dataLines.join('\n')
      if (!data) continue
      let parsed = null
      try { parsed = JSON.parse(data) } catch { /* tolerated — non-JSON deltas exist */ }
      if (evt === 'error' && parsed?.error) throw new Error(parsed.error)
      onEvent?.(evt, parsed, data)
    }
  }
}

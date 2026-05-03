// In-flight T-pose generations keyed by pubkey.
//
// Lives outside React so a generation survives drawer-tab switches and
// unmounts of AgentAssets. The component subscribes via
// useSyncExternalStore and renders a snapshot.

const states = new Map() // pubkey -> state
const subs = new Map()   // pubkey -> Set<listener>
const ctrls = new Map()  // pubkey -> AbortController

const EMPTY = {
  loading: false,
  stage: null,
  stageMessage: '',
  etaSeconds: null,
  startedAt: null,        // timestamp the active phase began (for elapsed ticker)
  heartbeatElapsedMs: 0,  // last server-reported elapsed (during cold-start phase)
  tposeUrl: null,
  error: null,
}

export function getState(pubkey) {
  return states.get(pubkey) ?? EMPTY
}

export function subscribe(pubkey, listener) {
  let set = subs.get(pubkey)
  if (!set) { set = new Set(); subs.set(pubkey, set) }
  set.add(listener)
  return () => set.delete(listener)
}

function setState(pubkey, patch) {
  const next = { ...(states.get(pubkey) ?? EMPTY), ...patch }
  states.set(pubkey, next)
  subs.get(pubkey)?.forEach((fn) => fn())
}

export function isRunning(pubkey) {
  return ctrls.has(pubkey)
}

export function cancel(pubkey) {
  ctrls.get(pubkey)?.abort()
}

export async function start({ pubkey, bridgeUrl }) {
  if (!pubkey || !bridgeUrl) return
  if (ctrls.has(pubkey)) return // already running

  const ctrl = new AbortController()
  ctrls.set(pubkey, ctrl)

  setState(pubkey, {
    loading: true,
    stage: 'probing',
    stageMessage: 'checking flux service…',
    etaSeconds: null,
    startedAt: Date.now(),
    heartbeatElapsedMs: 0,
    error: null,
  })

  try {
    const res = await fetch(`${bridgeUrl}/characters/${pubkey}/generate-tpose/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
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
        let eventType = 'message'
        const dataLines = []
        for (const line of lines) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        const data = dataLines.join('\n')
        if (!data) continue
        let parsed
        try { parsed = JSON.parse(data) } catch { continue }

        if (eventType === 'stage') {
          const patch = {
            stage: parsed.stage,
            stageMessage: parsed.message || '',
          }
          if (typeof parsed.etaSeconds === 'number') patch.etaSeconds = parsed.etaSeconds
          if (parsed.stage === 'cold-start') {
            patch.startedAt = Date.now()
            patch.heartbeatElapsedMs = 0
          } else if (parsed.stage === 'generating' && parsed.startedAt) {
            patch.startedAt = parsed.startedAt
            patch.heartbeatElapsedMs = 0
          }
          setState(pubkey, patch)
        } else if (eventType === 'heartbeat') {
          if (typeof parsed.elapsedMs === 'number') {
            setState(pubkey, { heartbeatElapsedMs: parsed.elapsedMs })
          }
        } else if (eventType === 'done') {
          setState(pubkey, {
            stage: 'done',
            stageMessage: 'done',
            tposeUrl: parsed.tposeUrl,
          })
        } else if (eventType === 'error') {
          throw new Error(parsed.error || 'stream error')
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      setState(pubkey, { stage: 'error', error: err.message || String(err) })
    } else {
      setState(pubkey, { stage: null, stageMessage: '' })
    }
  } finally {
    ctrls.delete(pubkey)
    setState(pubkey, { loading: false })
  }
}

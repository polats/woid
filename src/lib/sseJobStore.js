// Generic per-pubkey SSE job store. Used by tposeStore (T-pose generation)
// and modelStore (3D model generation) — both speak the same stage / heartbeat
// / done / error event schema.
//
// Each created store exposes start({pubkey, bridgeUrl}), cancel(pubkey),
// getState(pubkey), subscribe(pubkey, listener), isRunning(pubkey), and
// resultUrlField (e.g. 'tposeUrl' or 'modelUrl') so consumers can read the
// done payload's URL through a stable key.

const EMPTY = {
  loading: false,
  stage: null,
  stageMessage: '',
  etaSeconds: null,
  startedAt: null,
  heartbeatElapsedMs: 0,
  resultUrl: null,
  error: null,
}

export function createSseJobStore({ pathFor, resultUrlField }) {
  const states = new Map()
  const subs = new Map()
  const ctrls = new Map()

  function getState(pubkey) {
    return states.get(pubkey) ?? EMPTY
  }

  function subscribe(pubkey, listener) {
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

  function isRunning(pubkey) {
    return ctrls.has(pubkey)
  }

  function cancel(pubkey) {
    ctrls.get(pubkey)?.abort()
  }

  async function start({ pubkey, bridgeUrl, body, meta }) {
    if (!pubkey || !bridgeUrl) return
    if (ctrls.has(pubkey)) return

    const ctrl = new AbortController()
    ctrls.set(pubkey, ctrl)

    setState(pubkey, {
      loading: true,
      stage: 'probing',
      stageMessage: 'checking service…',
      etaSeconds: null,
      startedAt: Date.now(),
      heartbeatElapsedMs: 0,
      error: null,
      // `meta` lets callers stash arbitrary context (e.g. which mesh
      // backend started this run) so the UI can label the result.
      ...(meta ? { meta } : { meta: null }),
    })

    try {
      const res = await fetch(`${bridgeUrl}${pathFor(pubkey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
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
              resultUrl: parsed[resultUrlField],
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

  return { start, cancel, getState, subscribe, isRunning }
}

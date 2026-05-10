/**
 * Per-room 3D scene state. The scene is a single GLB produced by feeding
 * the latest mockup PNG through TRELLIS image-to-3d — one mesh that
 * represents the whole room. Distinct from the per-prop pipeline in
 * roomAssetStore.
 */

import config from '../config.js'

const BRIDGE_URL = config.agentSandbox?.bridgeUrl || ''
const STORAGE_KEY = 'woid:roomScenes:v1'

export const ROOM_SCENE_STATUS = {
  idle: 'idle',
  generating: 'generating',
  ready: 'ready',
  failed: 'failed',
}

const listeners = new Set()
let state = loadState()

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch { return {} }
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* ignore */ }
}

function emit() {
  for (const fn of listeners) {
    try { fn(state) } catch { /* not our problem */ }
  }
}

function update(roomId, patch) {
  const prev = state[roomId] || {}
  state = { ...state, [roomId]: { ...prev, ...patch, updatedAt: Date.now() } }
  persist()
  emit()
}

export function getScene(roomId) { return state[roomId] || null }
export function getAllScenes() { return state }

export function subscribe(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export async function generate(roomId) {
  if (!BRIDGE_URL) {
    update(roomId, { status: ROOM_SCENE_STATUS.failed, error: 'no bridge configured' })
    return
  }
  update(roomId, { status: ROOM_SCENE_STATUS.generating, error: null, stageMessage: 'connecting…' })
  try {
    const res = await fetch(
      `${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/scene/generate/stream`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    )
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let resultUrl = null
    let finalError = null
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
          update(roomId, { stage: parsed.stage, stageMessage: parsed.message || parsed.stage || '' })
        } else if (eventType === 'heartbeat') {
          update(roomId, { heartbeatElapsedMs: parsed.elapsedMs ?? 0 })
        } else if (eventType === 'done') {
          resultUrl = parsed.url ? `${parsed.url}?t=${Date.now()}` : null
        } else if (eventType === 'error') {
          finalError = parsed.error || 'stream error'
        }
      }
    }

    if (finalError) throw new Error(finalError)
    if (!resultUrl) throw new Error('stream ended without a result URL')
    update(roomId, { status: ROOM_SCENE_STATUS.ready, modelUrl: resultUrl, stageMessage: 'done' })
  } catch (err) {
    update(roomId, { status: ROOM_SCENE_STATUS.failed, error: err.message || String(err) })
  }
}

export async function refreshFromBridge(roomId) {
  if (!BRIDGE_URL) return
  try {
    const r = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/scenes`)
    if (!r.ok) return
    const j = await r.json()
    const latest = j.scenes?.[0]
    if (!latest) return
    const cur = state[roomId] || {}
    if (!cur.modelUrl) {
      update(roomId, { status: ROOM_SCENE_STATUS.ready, modelUrl: `${latest.url}?t=${latest.ts}` })
    }
  } catch { /* offline is fine */ }
}

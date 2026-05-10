/**
 * Room mock store — per-room mockup pipeline state. Distinct from
 * roomAssetStore (which is per-prop): a "mock" is a 2D concept render
 * of an entire room produced by FLUX-Kontext from multi-angle 3D
 * reference shots + the prop prompt list.
 *
 * Today the FLUX call is stubbed: it composites the references into
 * an SVG showing what *would* have been sent. This makes the workflow
 * observable end-to-end without a backend dependency. The bridge
 * endpoint (POST /rooms/:roomId/mocks/generate/stream) replaces the
 * mock without any UI changes.
 *
 * State per room:
 *   { status, references: [{angle, dataUri}], prompt, outputs: [dataUri], error, updatedAt }
 *
 * Status:
 *   idle → capturing → captured → generating → ready → failed
 */

import config from '../config.js'
import { ROOM_TYPES } from './shelterWorld/roomTypes.js'
import { STYLE_PROMPT_PREFIX, STYLE_PROMPT_NEGATIVE } from './shelterWorld/officeStyle.js'
import { captureRoomMocks } from './roomMockCapture.js'

const BRIDGE_URL = config.agentSandbox?.bridgeUrl || ''

const STORAGE_KEY = 'woid:roomMocks:v1'

export const ROOM_MOCK_STATUS = {
  idle: 'idle',
  capturing: 'capturing',
  captured: 'captured',
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
  // Strip dataURI references before persisting — they're 200-500KB each
  // and regeneratable from the 3D preview on demand. Output URLs are
  // small (point at bridge files) so those stay.
  try {
    const slim = {}
    for (const [k, v] of Object.entries(state)) {
      slim[k] = { ...v, references: v.references ? v.references.map((r) => ({ angle: r.angle })) : [] }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim))
  } catch { /* quota or serialisation issue — non-fatal */ }
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

export function getMock(roomId) { return state[roomId] || null }
export function getAllMocks() { return state }

export function subscribe(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Capture multi-angle screenshots of the room's 3D preview and store
 * them as references. Side-effect-free wrt FLUX — call generate() next
 * to actually produce a mockup.
 */
export async function captureReferences(roomId) {
  const room = ROOM_TYPES[roomId]
  if (!room) return
  update(roomId, { status: ROOM_MOCK_STATUS.capturing, error: null })
  try {
    // captureRoomMocks now takes a roomId and pulls the layout itself,
    // so the references reflect the same gray-box the user sees in the
    // preview (real dimensions + positions, not the static slot grid).
    const references = await captureRoomMocks(roomId, { width: 768, height: 768 })
    update(roomId, { status: ROOM_MOCK_STATUS.captured, references, prompt: buildPrompt(room) })
  } catch (err) {
    update(roomId, { status: ROOM_MOCK_STATUS.failed, error: err.message || String(err) })
  }
}

/**
 * Send references + prompt to the pi-bridge `/rooms/:roomId/mocks/generate/stream`
 * endpoint, which composites the references into a 2×2 grid and runs
 * flux-kontext over them. Streams SSE events: stage / heartbeat / done / error.
 *
 * Falls back to the SVG stub when no bridge is configured (so the UI
 * still demos without a backend).
 */
export async function generate(roomId) {
  const cur = state[roomId]
  if (!cur || cur.status === ROOM_MOCK_STATUS.idle || !cur.references?.length) {
    await captureReferences(roomId)
  }
  const refs = state[roomId]?.references
  const prompt = state[roomId]?.prompt
  if (!refs?.length) return
  update(roomId, { status: ROOM_MOCK_STATUS.generating, error: null, stageMessage: 'connecting…' })

  if (!BRIDGE_URL) {
    // Stub fallback (no bridge configured). Same SVG placeholder as before.
    await new Promise((r) => setTimeout(r, 1200))
    const room = ROOM_TYPES[roomId]
    update(roomId, {
      status: ROOM_MOCK_STATUS.ready,
      outputs: [makeStubOutput(room, prompt, refs)],
      stageMessage: 'stub (no bridge)',
    })
    return
  }

  try {
    const res = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/mocks/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ references: refs, prompt }),
    })
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
          update(roomId, {
            stage: parsed.stage,
            stageMessage: parsed.message || parsed.stage || '',
          })
        } else if (eventType === 'heartbeat') {
          update(roomId, { heartbeatElapsedMs: parsed.elapsedMs ?? 0 })
        } else if (eventType === 'done') {
          // Cache-bust so re-runs reload the new file.
          resultUrl = parsed.url ? `${parsed.url}?t=${Date.now()}` : null
        } else if (eventType === 'error') {
          finalError = parsed.error || 'stream error'
        }
      }
    }

    if (finalError) throw new Error(finalError)
    if (!resultUrl) throw new Error('stream ended without a result URL')

    // Append to outputs so re-runs accumulate a history per session.
    const prevOutputs = state[roomId]?.outputs || []
    update(roomId, {
      status: ROOM_MOCK_STATUS.ready,
      outputs: [resultUrl, ...prevOutputs].slice(0, 6),
      stageMessage: 'done',
    })
  } catch (err) {
    update(roomId, {
      status: ROOM_MOCK_STATUS.failed,
      error: err.message || String(err),
    })
  }
}

/**
 * Reload mocks list from the bridge so the UI shows previously-generated
 * outputs after a page reload (or when first opening a room). Idempotent.
 */
export async function refreshFromBridge(roomId) {
  if (!BRIDGE_URL) return
  try {
    const r = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/mocks`)
    if (!r.ok) return
    const j = await r.json()
    const urls = (j.mocks || []).map((m) => m.url)
    if (!urls.length) return
    const cur = state[roomId] || {}
    // Only seed when local state has no outputs yet, to avoid clobbering
    // an in-flight run.
    if (!cur.outputs?.length) {
      update(roomId, {
        status: ROOM_MOCK_STATUS.ready,
        outputs: urls,
      })
    }
  } catch { /* offline is fine */ }
}

export function reset(roomId) {
  if (!state[roomId]) return
  const next = { ...state }
  delete next[roomId]
  state = next
  persist()
  emit()
}

// ─── prompt assembly ─────────────────────────────────────────────

function buildPrompt(room) {
  const propLines = (room.props || [])
    .map((p) => `- ${p.id} (${p.slot}${p.count > 1 ? `, ×${p.count}` : ''}): ${p.prompt}`)
    .join('\n')
  return [
    `Room: ${room.name} — ${room.description}`,
    `Vibe: ${room.vibe || ''}`,
    `Style: ${STYLE_PROMPT_PREFIX}`,
    `Avoid: ${STYLE_PROMPT_NEGATIVE}`,
    `Props in this room:`,
    propLines,
    'Render as a polished interior concept illustration that respects the layout shown in the reference shots, replacing the primitive placeholder boxes with the described props.',
  ].join('\n\n')
}

// ─── stub output ─────────────────────────────────────────────────

function makeStubOutput(room, prompt, refs) {
  const palette = room.palette || {}
  const wall = palette.wall || '#d8cdb4'
  const accent = palette.accent || '#c8a868'
  const promptHead = (prompt || '').split('\n')[0]
  const refCount = refs.length
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">
  <defs>
    <linearGradient id="g" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${wall}"/>
      <stop offset="1" stop-color="${shade(wall, -18)}"/>
    </linearGradient>
  </defs>
  <rect width="800" height="800" fill="url(#g)"/>
  <rect x="40" y="40" width="720" height="720" fill="none" stroke="${accent}" stroke-width="3" stroke-dasharray="10 8"/>
  <text x="400" y="120" text-anchor="middle" font-family="ui-monospace, monospace" font-size="22" fill="#222">FLUX MOCKUP — STUB</text>
  <text x="400" y="160" text-anchor="middle" font-family="ui-monospace, monospace" font-size="14" fill="#444" opacity="0.7">${escape(room.name)}</text>
  <text x="400" y="220" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13" fill="#222">received ${refCount} reference shot${refCount === 1 ? '' : 's'}</text>
  <text x="400" y="244" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="#444" opacity="0.7">${escape(promptHead.slice(0, 80))}</text>
  <text x="400" y="690" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="#444" opacity="0.6">wire pi-bridge /rooms/:id/mocks/generate to replace this stub</text>
  <text x="400" y="710" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="#444" opacity="0.6">with real flux-kontext output</text>
</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function shade(hex, deltaPct) {
  const m = hex.match(/^#([0-9a-f]{6})$/i)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff
  const f = 1 + deltaPct / 100
  r = Math.max(0, Math.min(255, Math.round(r * f)))
  g = Math.max(0, Math.min(255, Math.round(g * f)))
  b = Math.max(0, Math.min(255, Math.round(b * f)))
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

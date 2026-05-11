/**
 * Room asset store — bridge-shaped facade for the rooms generation
 * pipeline. Today it's a localStorage-backed mock that simulates the
 * FLUX → TRELLIS round-trip with timers and canned thumbnail fallbacks.
 * The public API is intentionally shaped like the real bridge endpoints
 * we'll add later, so swapping the implementation is one import change
 * (and unsetting the mock flag).
 *
 * One *prop id* corresponds to one generation work-unit. Many rooms
 * reference the same prop id (e.g. `office-chair-swivel` appears in
 * MDR, Refinement Floor, Conference Room, Cubicle Farm) — generation
 * runs *once per prop id*, and every room sharing it sees the result.
 *
 * Status state machine per prop:
 *   idle → queued → generating-image → generating-model → ready
 *                                                       ↘ failed
 *
 * Public API:
 *   getStatus(propId)         → record or null
 *   getAll()                  → object keyed by propId
 *   subscribe(fn)             → unsubscribe()
 *   generate(propId, prompt)  → kicks off the pipeline (idempotent)
 *   reset(propId)             → clears state for a prop
 *   resetAll()                → clears all
 */

import config from '../config.js'
import { ROOM_TYPES, listAllPropRefs } from './shelterWorld/roomTypes.js'
import { buildPropPrompt } from './shelterWorld/officeStyle.js'

const BRIDGE_URL = config.agentSandbox?.bridgeUrl || ''

const STORAGE_KEY = 'woid:roomAssets:v1'

const STATUS = {
  idle: 'idle',
  queued: 'queued',
  generatingImage: 'generating-image',
  generatingModel: 'generating-model',
  ready: 'ready',
  failed: 'failed',
}

// Listeners notified on every state change.
const listeners = new Set()

// Per-prop record map. Persisted to localStorage as JSON.
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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* quota */ }
}

function emit() {
  for (const fn of listeners) {
    try { fn(state) } catch { /* listener errors are not our problem */ }
  }
}

function update(propId, patch) {
  const prev = state[propId] || {}
  state = { ...state, [propId]: { ...prev, ...patch, updatedAt: Date.now() } }
  persist()
  emit()
}

export const ROOM_ASSET_STATUS = STATUS

export function getStatus(propId) {
  return state[propId] || null
}

export function getAll() {
  return state
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Index of which rooms reference each prop id. Computed lazily; rooms
 * are static so we cache it once. The drawer uses this for "shared
 * with N rooms" badges.
 */
let _roomsByProp = null
export function getRoomsForProp(propId) {
  if (!_roomsByProp) {
    _roomsByProp = {}
    for (const ref of listAllPropRefs()) {
      if (!_roomsByProp[ref.id]) _roomsByProp[ref.id] = []
      // dedup — same prop can repeat with count>1 within one room
      if (!_roomsByProp[ref.id].includes(ref.roomId)) {
        _roomsByProp[ref.id].push(ref.roomId)
      }
    }
  }
  return _roomsByProp[propId] || []
}

/**
 * Kick off the generation pipeline for a prop. Two SSE flows back to back:
 *   1. POST /props/:id/image/generate/stream  (FLUX text-to-image)
 *   2. POST /props/:id/model/generate/stream  (TRELLIS image-to-3d)
 *
 * Idempotent: a re-call while already in flight is a no-op. Pass
 * `force: true` to regenerate from scratch.
 */
export async function generate(propId, prompt, opts = {}) {
  const cur = state[propId]
  if (cur && !opts.force) {
    if (cur.status === STATUS.ready) return
    if (cur.status === STATUS.queued
        || cur.status === STATUS.generatingImage
        || cur.status === STATUS.generatingModel) return
  }
  const fullPrompt = buildPropPrompt(prompt)
  update(propId, {
    status: STATUS.queued,
    prompt: fullPrompt,
    sourcePrompt: prompt,    // raw description for the library drawer
    sourceKind: opts.kind,   // optional metadata from caller
    error: null,
  })

  if (!BRIDGE_URL) {
    update(propId, { status: STATUS.failed, error: 'no bridge configured' })
    return
  }

  try {
    // ── Stage 1: FLUX text-to-image ────────────────────────────────
    update(propId, { status: STATUS.generatingImage, stageMessage: 'flux text-to-image' })
    const imageResult = await runStream(
      `${BRIDGE_URL}/props/${encodeURIComponent(propId)}/image/generate/stream`,
      // palette + roomId let the bridge prefix FLUX with the parent
      // room's exact colours so the rendered prop matches the mock.
      // imageProviderId picks which NIM model handles the call.
      {
        prompt: fullPrompt,
        palette: opts.palette,
        roomId: opts.roomId,
        imageProviderId: opts.imageProviderId,
      },
      (event, data) => {
        if (event === 'stage') {
          update(propId, { stageMessage: data.message || data.stage || '' })
        }
      },
    )
    if (!imageResult.url) throw new Error('image stream ended without url')
    update(propId, {
      status: STATUS.generatingModel,
      imageUrl: imageResult.url,
      stageMessage: 'trellis warming…',
    })

    // ── Stage 2: TRELLIS image-to-3d ───────────────────────────────
    const modelResult = await runStream(
      `${BRIDGE_URL}/props/${encodeURIComponent(propId)}/model/generate/stream`,
      null,
      (event, data) => {
        if (event === 'stage') {
          update(propId, { stageMessage: data.message || data.stage || '' })
        } else if (event === 'heartbeat') {
          update(propId, { heartbeatElapsedMs: data.elapsedMs ?? 0 })
        }
      },
    )
    if (!modelResult.url) throw new Error('model stream ended without url')
    update(propId, {
      status: STATUS.ready,
      modelUrl: modelResult.url,
      stageMessage: 'done',
      ready: true,
    })
  } catch (err) {
    update(propId, { status: STATUS.failed, error: err.message || String(err) })
  }
}

/**
 * Pipe an SSE stream and return the `done` payload. Every event is also
 * dispatched to the `onEvent` callback so the caller can patch state as
 * stages roll in.
 */
async function runStream(url, body, onEvent) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let donePayload = null
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
      onEvent?.(eventType, parsed)
      if (eventType === 'done') donePayload = parsed
      else if (eventType === 'error') finalError = parsed.error || 'stream error'
    }
  }
  if (finalError) throw new Error(finalError)
  return donePayload || {}
}

/**
 * Recover prop state from the bridge so previously-generated GLBs load
 * after a page refresh. Called from RoomPreview3D / ShelterRoomDetail
 * when a room opens.
 */
export async function refreshFromBridge(propId) {
  if (!BRIDGE_URL) return
  // Skip if local state already has a modelUrl — avoids clobbering an
  // in-flight run.
  const cur = state[propId]
  if (cur?.modelUrl && cur?.status === STATUS.ready) return
  try {
    const r = await fetch(`${BRIDGE_URL}/props/${encodeURIComponent(propId)}/state`)
    if (!r.ok) return
    const j = await r.json()
    if (j.hasModel) {
      update(propId, {
        status: STATUS.ready,
        modelUrl: `${j.modelUrl}?t=${Date.now()}`,
        imageUrl: j.imageUrl ? `${j.imageUrl}?t=${Date.now()}` : null,
        ready: true,
      })
    } else if (j.hasImage) {
      update(propId, {
        status: STATUS.generatingModel,
        imageUrl: `${j.imageUrl}?t=${Date.now()}`,
        stageMessage: 'image only — model pending',
      })
    }
  } catch { /* offline ok */ }
}

/** Bulk recover state for every prop in a room — called when the
 *  drawer opens so all loaded GLBs surface immediately. Static rooms
 *  use the catalogue; LLM-generated rooms (not in ROOM_TYPES) fall
 *  back to the bridge layout's prop list. */
export async function refreshRoomFromBridge(roomId) {
  if (!roomId) return
  // Always prefer the bridge layout's prop list as the source of truth.
  // For built-in rooms the migrated layout's props can diverge from the
  // static ROOM_TYPES catalogue (counts and ids both differ after
  // edits), and the shelter renders against the bridge layout — so the
  // editor's asset summary should too. Fall back to the static
  // catalogue only when the bridge has no layout for this room.
  if (BRIDGE_URL) {
    try {
      const r = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/layout`)
      if (r.ok) {
        const j = await r.json()
        const props = j.layout?.props || []
        if (props.length) {
          for (const p of props) refreshFromBridge(p.id)
          return
        }
      }
    } catch { /* offline → catalogue fallback */ }
  }
  const room = ROOM_TYPES[roomId]
  if (room?.props) for (const prop of room.props) refreshFromBridge(prop.id)
}

export function reset(propId) {
  if (!state[propId]) return
  const next = { ...state }
  delete next[propId]
  state = next
  persist()
  emit()
}

export function resetAll() {
  state = {}
  persist()
  emit()
}

/**
 * Generate every prop referenced by a given room. Skips props already
 * ready or in flight. Returns the list of prop ids that were kicked
 * off (useful for progress UI).
 */
export function generateRoom(roomId, opts = {}) {
  // Source can be: a static room from ROOM_TYPES, or a layout-only
  // room passed in via opts.props (LLM-generated rooms aren't in
  // ROOM_TYPES). opts.palette is forwarded to each prop's FLUX call.
  const room = ROOM_TYPES[roomId]
  const props = opts.props || room?.props || []
  if (!props.length) return []
  const fired = []
  for (const prop of props) {
    const cur = state[prop.id]
    if (cur && (cur.status === STATUS.ready
                || cur.status === STATUS.queued
                || cur.status === STATUS.generatingImage
                || cur.status === STATUS.generatingModel)) continue
    generate(prop.id, prop.prompt, {
      kind: prop.kind,
      palette: opts.palette,
      roomId,
    })
    fired.push(prop.id)
  }
  return fired
}

/**
 * Roll up status counts for a room — used by sidebar cards to show
 * "3/5 assets ready" badges without each card subscribing individually.
 */
export function summarizeRoom(roomId) {
  const room = ROOM_TYPES[roomId]
  return summarizeProps(room?.props || [])
}

/** Same shape as summarizeRoom but operates on any explicit prop list
 *  — useful for built-in rooms whose bridge layout's props differ from
 *  the static catalogue, and for generated rooms (not in ROOM_TYPES). */
export function summarizeProps(props) {
  if (!props?.length) return { total: 0, ready: 0, inFlight: 0, failed: 0 }
  let ready = 0, inFlight = 0, failed = 0
  for (const prop of props) {
    const s = state[prop.id]?.status
    if (s === STATUS.ready) ready += 1
    else if (s === STATUS.failed) failed += 1
    else if (s === STATUS.queued
             || s === STATUS.generatingImage
             || s === STATUS.generatingModel) inFlight += 1
  }
  return { total: props.length, ready, inFlight, failed }
}

/**
 * Make a small data: URI that visualises the prop as a colored card —
 * stand-in for the real FLUX output. Hash the prop id to a stable hue
 * so re-runs look the same and props read as recognisable thumbnails
 * rather than identical placeholders.
 */
function makePlaceholderDataUri(propId, kind) {
  const hue = hashHue(propId)
  const bg = `hsl(${hue}, 22%, 78%)`
  const fg = `hsl(${hue}, 30%, 32%)`
  const label = propId.replace(/-/g, ' ')
  const tag = kind === 'image' ? 'FLUX' : 'TRELLIS'
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="${bg}"/>
  <rect x="14" y="14" width="172" height="172" fill="none" stroke="${fg}" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="100" y="98" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="${fg}">${escape(label)}</text>
  <text x="100" y="118" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" fill="${fg}" opacity="0.6">${tag}</text>
</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function hashHue(s) {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function escape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

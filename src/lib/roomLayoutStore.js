/**
 * Room layout store — caches `/rooms/:id/layout` per room id, exposes
 * a subscribe API so the gray-box renderer / detail panel update when
 * the layout changes (Phase 4 will add edit ops that PUT back).
 *
 * Layouts are fetched lazily on first request. A second call for the
 * same id returns the cached value immediately and re-fires the fetch
 * in the background to pick up disk changes.
 */

import config from '../config.js'
import { validateLayout } from './roomLayoutSchema.js'

const BRIDGE_URL = config.agentSandbox?.bridgeUrl || ''

export const ROOM_LAYOUT_STATUS = {
  idle: 'idle',
  loading: 'loading',
  ready: 'ready',
  missing: 'missing',
  invalid: 'invalid',
  error: 'error',
}

const listeners = new Set()
const state = {} // id → { status, layout, errors, mtime, lastFetched }

function emit() {
  for (const fn of listeners) {
    try { fn(state) } catch { /* not our problem */ }
  }
}

function update(roomId, patch) {
  state[roomId] = { ...(state[roomId] || {}), ...patch, lastUpdated: Date.now() }
  emit()
}

export function getLayout(roomId) {
  return state[roomId] || null
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Fetch a layout from the bridge. Always re-fetches; consumers can
 * decide whether to skip when `state[roomId]?.status === 'ready'`.
 * Validates with the schema and reports normalised data.
 */
export async function fetchLayout(roomId) {
  if (!BRIDGE_URL) {
    update(roomId, { status: ROOM_LAYOUT_STATUS.error, errors: ['no bridge configured'] })
    return null
  }
  if (state[roomId]?.status !== ROOM_LAYOUT_STATUS.ready) {
    update(roomId, { status: ROOM_LAYOUT_STATUS.loading })
  }
  try {
    const r = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/layout`)
    if (r.status === 404) {
      update(roomId, { status: ROOM_LAYOUT_STATUS.missing, errors: ['no layout on disk'] })
      return null
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    const v = validateLayout(j.layout)
    if (!v.ok) {
      update(roomId, {
        status: ROOM_LAYOUT_STATUS.invalid,
        errors: v.errors,
        warnings: v.warnings,
        rawLayout: j.layout,
      })
      return null
    }
    update(roomId, {
      status: ROOM_LAYOUT_STATUS.ready,
      layout: v.value,
      warnings: v.warnings,
      mtime: j.mtime,
      errors: [],
    })
    return v.value
  } catch (err) {
    update(roomId, { status: ROOM_LAYOUT_STATUS.error, errors: [err.message || String(err)] })
    return null
  }
}

/**
 * Generate a new layout via the bridge LLM endpoint. SSE-streams stage
 * messages back through `onProgress`. On success, refetches the saved
 * layout (the bridge writes it to disk) and returns it. Throws on
 * irrecoverable error after the bridge's own 3-attempt retry.
 */
/**
 * Build the concept-image URL for a room. The bridge serves it at
 * /rooms/:id/concept; we cache-bust off the layout's mtime so refreshes
 * after a regenerate reload the new bytes.
 */
export function conceptUrl(roomId, mtime) {
  if (!BRIDGE_URL || !roomId) return null
  const t = mtime || Date.now()
  return `${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/concept?t=${t}`
}

/**
 * Trigger a concept-image regenerate. Pass `prompt` to override the
 * stored fluxPrompt; pass `persistPrompt: true` to also write the
 * override back into layout.json so it survives.
 */
export async function regenerateConcept({ roomId, prompt, persistPrompt, imageProviderId }) {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  const r = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/concept/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: prompt || undefined,
      persistPrompt: !!persistPrompt,
      imageProviderId: imageProviderId || undefined,
    }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`regenerate concept ${r.status}: ${body.slice(0, 200)}`)
  }
  return r.json()
}

/**
 * Fetch the list of all room layouts on the bridge. Used by the Rooms
 * page to surface LLM-generated rooms alongside the static seeds.
 */
export async function listLayouts() {
  if (!BRIDGE_URL) return []
  try {
    const r = await fetch(`${BRIDGE_URL}/room-layouts`)
    if (!r.ok) return []
    const j = await r.json()
    return j.rooms || []
  } catch { return [] }
}

/**
 * Flip a room between 'draft' (lives in the room editor only) and
 * 'added' (also visible in the shelter build menu). Persists to the
 * layout.json on the bridge.
 */
export async function setRoomStatus(roomId, status) {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  if (status !== 'draft' && status !== 'added') {
    throw new Error(`invalid status: ${status}`)
  }
  const r = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`setRoomStatus failed: ${r.status} ${body}`)
  }
  return r.json()
}

export async function generateFromPrompt({ roomId, prompt, basedOn, dimensions, skipConcept, providerId, onProgress }) {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  if (!roomId) throw new Error('roomId required')
  update(roomId, { status: ROOM_LAYOUT_STATUS.loading, errors: [], stageMessage: 'queued' })

  const res = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/layout/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, basedOn, dimensions, skipConcept, providerId }),
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
      onProgress?.(eventType, parsed)
      if (eventType === 'stage') {
        update(roomId, { stageMessage: parsed.message || parsed.stage || '' })
      } else if (eventType === 'done') {
        donePayload = parsed
      } else if (eventType === 'error') {
        finalError = parsed.error || 'stream error'
      }
    }
  }
  if (finalError) {
    update(roomId, { status: ROOM_LAYOUT_STATUS.error, errors: [finalError] })
    throw new Error(finalError)
  }
  if (!donePayload) {
    update(roomId, { status: ROOM_LAYOUT_STATUS.error, errors: ['stream ended without done event'] })
    throw new Error('stream ended without done event')
  }
  // Refetch the saved layout so cache reflects what the bridge wrote.
  return await fetchLayout(roomId)
}

/**
 * Regenerate ONLY the layout JSON, without touching the concept image
 * (saves a FLUX call). Re-runs Gemma using the existing fluxPrompt as
 * the brief — Gemma reshapes the room while the moodboard stays put.
 */
/**
 * Re-roll just the spatial layout (dimensions + props) from the
 * existing fluxPrompt + palette. Distinct from generateFromPrompt
 * which also re-creates the prompt — this flow keeps the prompt and
 * palette stable.
 */
export async function regenerateLayoutOnly({ roomId, providerId, onProgress } = {}) {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  const res = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/layout/from-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId }),
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
      onProgress?.(eventType, parsed)
      if (eventType === 'done') donePayload = parsed
      else if (eventType === 'error') finalError = parsed.error || 'stream error'
    }
  }
  if (finalError) throw new Error(finalError)
  await fetchLayout(roomId)
  return donePayload
}

/**
 * Re-derive the FLUX prompt + palette from the room's name+description
 * (and current vibe). Persists into layout.json server-side. Updates
 * the local cache on success so the detail panel sees the new values.
 */
/**
 * Re-derive the FLUX prompt + palette via Gemma streaming. `onProgress`
 * receives `stage`, `thinking`, and `token` SSE events so the UI can
 * show live LLM reasoning.
 */
export async function regeneratePromptAndPalette({ roomId, providerId, onProgress } = {}) {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  const res = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/prompt/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId }),
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
      onProgress?.(eventType, parsed)
      if (eventType === 'done') donePayload = parsed
      else if (eventType === 'error') finalError = parsed.error || 'stream error'
    }
  }
  if (finalError) throw new Error(finalError)
  // Refetch layout so the validated/normalised values land in cache.
  await fetchLayout(roomId)
  return donePayload
}

/**
 * Create the initial room concept (name, description, vibe, category,
 * flux_prompt, palette + concept image). Layout structure is generated
 * separately via `regenerateLayoutOnly` once this returns.
 */
export async function createInitialRoom({ roomId, prompt, providerId, imageProviderId, onProgress } = {}) {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  if (!roomId) throw new Error('roomId required')
  update(roomId, { status: ROOM_LAYOUT_STATUS.loading, errors: [] })
  const res = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(roomId)}/initial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, providerId, imageProviderId }),
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
      onProgress?.(eventType, parsed)
      if (eventType === 'done') donePayload = parsed
      else if (eventType === 'error') finalError = parsed.error || 'stream error'
    }
  }
  if (finalError) throw new Error(finalError)
  await fetchLayout(roomId)
  return donePayload
}

/** Read/write the LLM system prompt used by /rooms/:id/initial. */
export async function getInitialRoomPrompt() {
  if (!BRIDGE_URL) return null
  const r = await fetch(`${BRIDGE_URL}/v1/initial-prompt`)
  if (!r.ok) return null
  return r.json()
}
export async function setInitialRoomPrompt(text) {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  const r = await fetch(`${BRIDGE_URL}/v1/initial-prompt`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}
export async function resetInitialRoomPrompt() {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  const r = await fetch(`${BRIDGE_URL}/v1/initial-prompt`, { method: 'DELETE' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/** Fetch the list of available LLM providers (gemma + NIM presets). */
export async function listLlmProviders() {
  if (!BRIDGE_URL) return []
  try {
    const r = await fetch(`${BRIDGE_URL}/v1/llm/providers`)
    if (!r.ok) return []
    const j = await r.json()
    return j.providers || []
  } catch { return [] }
}

/** Fetch the list of available text-to-image providers. */
export async function listImageProviders() {
  if (!BRIDGE_URL) return []
  try {
    const r = await fetch(`${BRIDGE_URL}/v1/image/providers`)
    if (!r.ok) return []
    const j = await r.json()
    return j.providers || []
  } catch { return [] }
}

/**
 * PUT a modified layout back to the bridge. Validates first; on success
 * the local cache is replaced atomically. Phase 4 (drag-edit) calls this
 * after each commit; debounce upstream if needed.
 */
export async function saveLayout(layout) {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  const v = validateLayout(layout)
  if (!v.ok) throw new Error(`invalid layout: ${v.errors.join('; ')}`)
  const r = await fetch(`${BRIDGE_URL}/rooms/${encodeURIComponent(v.value.id)}/layout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(v.value),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`PUT ${v.value.id} → ${r.status}: ${body.slice(0, 200)}`)
  }
  update(v.value.id, {
    status: ROOM_LAYOUT_STATUS.ready,
    layout: v.value,
    warnings: v.warnings,
    errors: [],
    mtime: Date.now(),
  })
  return v.value
}

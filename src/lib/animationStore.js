// Thin client over the kimodo proxy. Animations live on the kimodo server
// in dev; on prod the same shape comes from the bridge's S3-backed
// `/v1/animations*` endpoints. The fetch helpers fall through:
//
//   listAnimations:  /api/kimodo/animations  →  ${bridge}/v1/animations
//   fetchAnimation:  /animations/<id>.json   →  ${bridge}/v1/animations/<id>
//                    →  /api/kimodo/animations/<id>
//
// Each tier validates response shape so a Vercel SPA fallback (which
// returns 200 + HTML for any path) doesn't poison callers.

import config from '../config.js'

const cfg = config.agentSandbox || {}

function isMotionRecord(m) {
  return m && typeof m === 'object' && Array.isArray(m.bone_names)
}

async function tryJsonFetch(url) {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    const ct = r.headers.get('content-type') || ''
    if (!ct.includes('application/json')) return null
    return await r.json()
  } catch { return null }
}

export async function listAnimations() {
  // Dev path — full local-kimodo list with prompts + metadata.
  const local = await tryJsonFetch('/api/kimodo/animations')
  if (local) {
    if (Array.isArray(local)) return local
    if (Array.isArray(local.animations)) return local.animations
  }
  // Prod path — bridge returns the published-set as
  // `{ animations: [{ id, sizeKb, publishedAt }] }`. Wrap each into a
  // minimal motion-card-shaped record so the existing grid renders.
  if (cfg.bridgeUrl) {
    const remote = await tryJsonFetch(`${cfg.bridgeUrl}/v1/animations`)
    if (remote && Array.isArray(remote.animations)) {
      return remote.animations.map((a) => ({
        id: a.id,
        prompt: '(published motion)',
        seconds: null,
        fps: null,
        sizeKb: a.sizeKb,
        publishedAt: a.publishedAt,
      }))
    }
  }
  return []
}

export async function fetchAnimation(id) {
  const enc = encodeURIComponent(id)
  // 1. Static bundle (built-in defaults shipped with the frontend).
  const fromStatic = await tryJsonFetch(`/animations/${enc}.json`)
  if (isMotionRecord(fromStatic)) return fromStatic
  // 2. Bridge-proxied S3 (user-published motions).
  if (cfg.bridgeUrl) {
    const fromBridge = await tryJsonFetch(`${cfg.bridgeUrl}/v1/animations/${enc}`)
    if (isMotionRecord(fromBridge)) return fromBridge
  }
  // 3. Vite dev middleware (only reachable in local dev).
  const fromKimodo = await tryJsonFetch(`/api/kimodo/animations/${enc}`)
  if (isMotionRecord(fromKimodo)) return fromKimodo
  throw new Error(`no motion found for ${id} (not published?)`)
}

export async function deleteAnimation(id) {
  const r = await fetch(`/api/kimodo/animations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
}

export async function generateAnimation({ prompt, seconds, seamPose, onStage, onHeartbeat }) {
  // seamPose, when set, pins frame 0 and frame N-1 of the new motion to the
  // pose from { anim_id, frame_idx } via a kimodo FullBodyConstraintSet —
  // the result loops cleanly. The source animation must have been generated
  // after kimodo started persisting `posed_joints` (older clips will 400).
  const body = { prompt, seconds: Number(seconds) || 2.0 }
  if (seamPose && seamPose.anim_id && Number.isFinite(seamPose.frame_idx)) {
    const sp = { anim_id: seamPose.anim_id, frame_idx: seamPose.frame_idx | 0 }
    // Optional [x, z] direction in seam-local frame (forward = +Z, right = +X).
    // Omitted → in-place loop. Present → translating loop along that vector.
    if (Array.isArray(seamPose.direction) && seamPose.direction.length === 2) {
      sp.direction = [Number(seamPose.direction[0]), Number(seamPose.direction[1])]
    }
    body.seam_pose = sp
  }
  const res = await fetch('/api/kimodo/generate/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let resultAnim = null
  let errorMessage = null

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

      if (eventType === 'stage') onStage?.(parsed.stage, parsed.message || '')
      else if (eventType === 'heartbeat') onHeartbeat?.(parsed.elapsedMs ?? 0)
      else if (eventType === 'done') resultAnim = parsed.animation
      else if (eventType === 'error') errorMessage = parsed.message || 'stream error'
    }
  }

  if (errorMessage) throw new Error(errorMessage)
  if (!resultAnim) throw new Error('no animation returned')
  return resultAnim
}

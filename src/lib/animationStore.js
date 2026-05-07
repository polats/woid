// Thin client over the kimodo proxy. Animations live on the kimodo server;
// woid is just a viewer + generator. SSE-streamed generate so the UI can
// show progress while the model runs.

export async function listAnimations() {
  const r = await fetch('/api/kimodo/animations')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = await r.json()
  // kimodo returns either {animations: [...]} or a bare array depending on
  // version — accept both shapes.
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.animations)) return data.animations
  return []
}

export async function fetchAnimation(id) {
  const r = await fetch(`/api/kimodo/animations/${encodeURIComponent(id)}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
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

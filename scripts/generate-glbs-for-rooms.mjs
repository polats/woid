#!/usr/bin/env node
/**
 * Generate TRELLIS GLBs for every prop in the listed rooms. Reuses
 * /props/:id/image and /props/:id/model endpoints. Resumes idempotently:
 * skips props that already have model.glb on disk.
 *
 * Usage: node scripts/generate-glbs-for-rooms.mjs <roomId> [<roomId>...]
 * If no args: pulls all room ids whose name starts with "e2e-v3-".
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function consumeSse(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = '', donePayload = null, errorMsg = null
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const events = buf.split(/\n\n/); buf = events.pop() ?? ''
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
      let parsed; try { parsed = JSON.parse(data) } catch { continue }
      if (eventType === 'done') donePayload = parsed
      else if (eventType === 'error') errorMsg = parsed.error || 'stream error'
    }
  }
  return { donePayload, errorMsg }
}

async function ensureImage(propId, prompt, roomId) {
  const state = await (await fetch(`${BRIDGE}/props/${propId}/state`)).json()
  if (state.hasImage) return { ok: true, cached: true }
  const r = await fetch(`${BRIDGE}/props/${propId}/image/generate/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, roomId }),
  })
  const { donePayload, errorMsg } = await consumeSse(r)
  return { ok: !!donePayload, error: errorMsg }
}

async function ensureModel(propId) {
  const state = await (await fetch(`${BRIDGE}/props/${propId}/state`)).json()
  if (state.hasModel) return { ok: true, cached: true }
  const r = await fetch(`${BRIDGE}/props/${propId}/model/generate/stream`, { method: 'POST' })
  const { donePayload, errorMsg } = await consumeSse(r)
  return { ok: !!donePayload, error: errorMsg }
}

async function generateForRoom(roomId) {
  const lr = await fetch(`${BRIDGE}/rooms/${roomId}/layout`)
  if (!lr.ok) { console.log(`  ! ${roomId}: no layout`); return }
  const layout = (await lr.json()).layout
  const props = layout.props || []
  console.log(`\n=== ${roomId} (${props.length} props) ===`)
  for (const p of props) {
    process.stdout.write(`  ${p.id.padEnd(28)} `)
    const img = await ensureImage(p.id, p.prompt, roomId)
    if (!img.ok) { console.log(`img✗ ${img.error}`); continue }
    process.stdout.write(`img${img.cached ? '·' : '✓'} `)
    const t0 = Date.now()
    const mdl = await ensureModel(p.id)
    if (!mdl.ok) { console.log(`mdl✗ ${mdl.error}`); continue }
    console.log(`mdl${mdl.cached ? '·' : '✓'} (${((Date.now()-t0)/1000).toFixed(1)}s)`)
    await sleep(1000)
  }
}

;(async () => {
  let roomIds = process.argv.slice(2)
  if (!roomIds.length) {
    const r = await (await fetch(`${BRIDGE}/room-layouts`)).json()
    roomIds = r.rooms.filter((x) => x.id.startsWith('e2e-v3-') && x.propCount > 0).map((x) => x.id)
  }
  console.log(`[glb] generating for ${roomIds.length} rooms`)
  for (const id of roomIds) await generateForRoom(id)
  console.log('\n[glb] done')
})().catch((err) => { console.error('[glb] fatal:', err); process.exit(1) })

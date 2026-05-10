#!/usr/bin/env node
/**
 * Full E2E for 3 rooms: prompt → initial → layout → per-prop FLUX → TRELLIS.
 *
 * For each room:
 *   1. POST /rooms/:id/initial            (Gemma/NIM produces flux-prompt + proposed_props)
 *   2. POST /rooms/:id/layout/from-prompt (places props in 3D)
 *   3. validateLayout()                   (frontend strict schema)
 *   4. For each prop: POST /props/:id/image/generate/stream then /model/generate/stream
 *
 * Output: a sanity report with dimensions, palette colours, prop sizes, and
 * which artefacts (image.png, model.glb) actually got produced. The report
 * is written to /tmp/test-3-rooms-full.json plus a markdown summary.
 *
 * Args:
 *   --provider=ID   (default: nim-kimi-k2-instruct)
 *   --concept=false (skip room concept FLUX call — we still want it on by default)
 *   --tag=v1        (suffix room ids so iterations don't collide on disk)
 */

import { validateLayout } from '../src/lib/roomLayoutSchema.js'
import { writeFileSync } from 'fs'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const PROVIDER = args.provider || 'nim-kimi-k2-instruct'
const SKIP_CONCEPT = args.concept === 'false'
const SKIP_MODELS = args.models === 'false' // when true, FLUX images only (no TRELLIS)
const TAG = args.tag || 'v1'
const REQ_DELAY_MS = Number(args.delay) || 4000
const LOG_PATH = args.log || '/tmp/test-3-rooms-full.json'
const REPORT_PATH = args.report || '/tmp/test-3-rooms-full.md'

const PROMPTS = [
  'a cold-grey institutional reception with a brass bell and one fern',
  'a clinical pale-lilac wellness session room with a single chair',
  'a Lumon-style oat-and-mint refinement bay with four desks facing inward',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const slug = (s, i) => `e2e-${TAG}-${String(i + 1).padStart(2, '0')}-`
  + s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)

async function consumeSse(res) {
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body })
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = '', donePayload = null, errorMsg = null, lastTokens = '', stages = []
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
      else if (eventType === 'token') lastTokens += parsed.text || ''
      else if (eventType === 'stage') stages.push(parsed.stage || parsed.message || '')
    }
  }
  return { donePayload, errorMsg, lastTokens, stages }
}

async function fetchLayout(roomId) {
  const r = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(roomId)}/layout`)
  if (!r.ok) return null
  return (await r.json()).layout
}

async function generatePropImage(propId, prompt, roomId) {
  const t0 = Date.now()
  const r = await fetch(`${BRIDGE}/props/${propId}/image/generate/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, roomId }),
  })
  const { donePayload, errorMsg } = await consumeSse(r)
  return { ok: !!donePayload, error: errorMsg, ms: Date.now() - t0, url: donePayload?.url }
}

async function generatePropModel(propId) {
  const t0 = Date.now()
  const r = await fetch(`${BRIDGE}/props/${propId}/model/generate/stream`, { method: 'POST' })
  const { donePayload, errorMsg } = await consumeSse(r)
  return { ok: !!donePayload, error: errorMsg, ms: Date.now() - t0, url: donePayload?.url }
}

async function getPropState(propId) {
  const r = await fetch(`${BRIDGE}/props/${propId}/state`)
  if (!r.ok) return null
  return r.json()
}

async function runOne(idx, prompt) {
  const roomId = slug(prompt, idx)
  const result = { idx, roomId, prompt, props: [], stages: {} }

  // Stage 1: initial
  const t0 = Date.now()
  try {
    const r = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(roomId)}/initial`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, providerId: PROVIDER, skipConcept: SKIP_CONCEPT }),
    })
    const { donePayload, errorMsg } = await consumeSse(r)
    result.stages.initial = { ok: !!donePayload, ms: Date.now() - t0, error: errorMsg }
    if (errorMsg || !donePayload) return result
  } catch (err) { result.stages.initial = { ok: false, error: err.message }; return result }

  await sleep(REQ_DELAY_MS)

  // Stage 2: from-prompt
  const t1 = Date.now()
  try {
    const r = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(roomId)}/layout/from-prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: PROVIDER }),
    })
    const { donePayload, errorMsg } = await consumeSse(r)
    result.stages.fromPrompt = { ok: !!donePayload, ms: Date.now() - t1, error: errorMsg }
    if (errorMsg || !donePayload) return result
  } catch (err) { result.stages.fromPrompt = { ok: false, error: err.message }; return result }

  // Stage 3: validate
  const layout = await fetchLayout(roomId)
  if (!layout) { result.stages.validate = { ok: false, error: 'layout missing' }; return result }
  const v = validateLayout(layout)
  result.stages.validate = { ok: v.ok, errors: v.errors, warnings: v.warnings }
  result.layout = {
    name: layout.name, dimensions: layout.dimensions, palette: layout.palette,
    fluxPrompt: layout.fluxPrompt, propCount: (layout.props || []).length,
    propsBrief: (layout.props || []).map((p) => ({
      id: p.id, kind: p.kind, size: p.size, position: p.position,
    })),
  }

  // Stage 4: per-prop FLUX → TRELLIS. Sequentially to avoid hammering services.
  const props = layout.props || []
  for (const p of props) {
    const propEntry = { id: p.id, kind: p.kind, prompt: p.prompt }
    await sleep(1500)
    const img = await generatePropImage(p.id, p.prompt, roomId)
    propEntry.image = img
    if (img.ok && !SKIP_MODELS) {
      await sleep(1500)
      const mdl = await generatePropModel(p.id)
      propEntry.model = mdl
    }
    propEntry.state = await getPropState(p.id)
    result.props.push(propEntry)
  }
  return result
}

function flag(ok) { return ok ? '✓' : '✗' }

function sanityChecks(r) {
  const issues = []
  if (!r.layout) return issues
  const { dimensions: d, palette: pal, propsBrief } = r.layout
  // Shelter scale: rooms should be roughly 6×4×3 (W×D×H) for characters to fit
  if (d.width < 4 || d.width > 14) issues.push(`dimensions.width ${d.width} outside [4,14] m`)
  if (d.depth < 3 || d.depth > 14) issues.push(`dimensions.depth ${d.depth} outside [3,14] m`)
  if (d.height < 2.4 || d.height > 4) issues.push(`dimensions.height ${d.height} outside [2.4,4] m`)
  // Palette: must have unique-ish wall vs floor vs accent (no all-grey)
  const cols = [pal.wall, pal.floor, pal.accent]
  if (new Set(cols).size < 3) issues.push(`palette has duplicate colours: ${cols.join(',')}`)
  // Floor & wall shouldn't be near-identical (within 16/255 on each channel)
  const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
  const [w, f] = [hex2rgb(pal.wall), hex2rgb(pal.floor)]
  if (Math.abs(w[0] - f[0]) < 16 && Math.abs(w[1] - f[1]) < 16 && Math.abs(w[2] - f[2]) < 16) {
    issues.push(`wall ${pal.wall} and floor ${pal.floor} too similar`)
  }
  // Prop sizing sanity per kind
  for (const p of propsBrief) {
    const { w, h, d: dp } = p.size
    if (p.kind === 'desk' && (h < 0.6 || h > 1.2)) issues.push(`${p.id} (desk) height ${h}m unrealistic`)
    if (p.kind === 'chair' && (h < 0.6 || h > 1.4)) issues.push(`${p.id} (chair) height ${h}m unrealistic`)
    if (p.kind === 'plant' && (h < 0.2 || h > 2.5)) issues.push(`${p.id} (plant) height ${h}m unrealistic`)
    if (p.kind === 'rug' && (h > 0.1)) issues.push(`${p.id} (rug) height ${h}m too tall`)
    if (w * h * dp > 100) issues.push(`${p.id} bbox ${w}×${h}×${dp} too large (>100m³)`)
    if (w < 0.05 || dp < 0.05) issues.push(`${p.id} bbox ${w}×${h}×${dp} too small`)
  }
  // Prop generation success rate
  const propResults = r.props || []
  const imgOk = propResults.filter((pp) => pp.image?.ok).length
  const mdlOk = propResults.filter((pp) => pp.model?.ok).length
  if (propResults.length && imgOk < propResults.length) issues.push(`${propResults.length - imgOk}/${propResults.length} prop images failed`)
  if (propResults.length && mdlOk < propResults.length) issues.push(`${propResults.length - mdlOk}/${propResults.length} prop GLBs failed`)
  return issues
}

;(async () => {
  console.log(`[full] bridge=${BRIDGE} provider=${PROVIDER} tag=${TAG}\n`)
  const results = []
  for (let i = 0; i < PROMPTS.length; i += 1) {
    if (i > 0) await sleep(REQ_DELAY_MS)
    console.log(`\n┏━ Room ${i + 1}: ${PROMPTS[i]}`)
    const r = await runOne(i, PROMPTS[i])
    const v = r.stages.validate
    const propsTotal = r.props?.length || 0
    const imgOk = r.props?.filter((p) => p.image?.ok).length || 0
    const mdlOk = r.props?.filter((p) => p.model?.ok).length || 0
    console.log(`┃   init=${flag(r.stages.initial?.ok)}  layout=${flag(r.stages.fromPrompt?.ok)}  valid=${flag(v?.ok)}  props=${propsTotal} images=${imgOk}/${propsTotal} glbs=${mdlOk}/${propsTotal}`)
    if (v && !v.ok && v.errors?.length) console.log(`┃   validation errors: ${v.errors.slice(0, 3).join(' | ')}`)
    if (r.stages.initial?.error) console.log(`┃   initial error: ${r.stages.initial.error}`)
    if (r.stages.fromPrompt?.error) console.log(`┃   fromPrompt error: ${r.stages.fromPrompt.error}`)
    const issues = sanityChecks(r)
    r.sanityIssues = issues
    if (issues.length) {
      console.log(`┃   sanity issues (${issues.length}):`)
      for (const iss of issues.slice(0, 6)) console.log(`┃     • ${iss}`)
    }
    console.log(`┗━`)
    results.push(r)
  }

  // Markdown summary
  const lines = [`# 3-room full E2E (tag=${TAG}, provider=${PROVIDER})`, '']
  for (const r of results) {
    lines.push(`## ${r.roomId}`)
    lines.push(`prompt: ${r.prompt}`)
    if (r.layout) {
      const d = r.layout.dimensions
      lines.push(`dims: ${d.width}×${d.depth}×${d.height}  palette: wall=${r.layout.palette.wall} floor=${r.layout.palette.floor} accent=${r.layout.palette.accent}`)
      lines.push(`props: ${r.layout.propCount}`)
      const imgOk = r.props.filter((p) => p.image?.ok).length
      const mdlOk = r.props.filter((p) => p.model?.ok).length
      lines.push(`images: ${imgOk}/${r.props.length}  glbs: ${mdlOk}/${r.props.length}`)
    }
    if (r.sanityIssues?.length) {
      lines.push(`### issues`)
      for (const i of r.sanityIssues) lines.push(`- ${i}`)
    }
    if (r.stages.validate?.errors?.length) {
      lines.push(`### schema errors`); for (const e of r.stages.validate.errors) lines.push(`- ${e}`)
    }
    lines.push('')
  }
  writeFileSync(REPORT_PATH, lines.join('\n'))
  writeFileSync(LOG_PATH, JSON.stringify(results, null, 2))
  console.log(`\nReport: ${REPORT_PATH}\nDetail: ${LOG_PATH}`)
})().catch((err) => { console.error('[full] fatal:', err); process.exit(1) })

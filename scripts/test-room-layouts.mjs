#!/usr/bin/env node
/**
 * Test which LLM provider produces the most reliable room layouts.
 *
 * Process:
 *   1. Ensure a canonical test room exists (creates one via /rooms/:id/initial
 *      if absent). The room's fluxPrompt + proposedProps become the
 *      fixed input every model is judged against.
 *   2. For each candidate model, run N trials of POST
 *      /rooms/:id/layout/from-prompt and measure:
 *        - validity:   does the saved layout pass roomLayoutSchema?
 *        - placement:  fraction of proposedProps positioned by the LLM
 *                      (vs synthesised by the bridge's reconciler).
 *        - elapsed:    ms wall-time.
 *   3. Print a markdown table summary, ranked by combined score.
 *
 * Usage:
 *   node scripts/test-room-layouts.mjs                # default models, 3 trials
 *   node scripts/test-room-layouts.mjs --trials=5
 *   node scripts/test-room-layouts.mjs --models=nim-deepseek-v4-pro,nim-kimi-k2.6
 *
 * Defaults: top six new models.
 */

import { validateLayout } from '../src/lib/roomLayoutSchema.js'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'

// ── CLI ──────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=')
      return [k, v ?? true]
    }),
)
const TRIALS = Number(args.trials) || 3
const TEST_ROOM_ID = args.room || 'test-llm-bench'
const TEST_BRIEF = args.brief || 'a quiet records archive with metal filing cabinets, a microfiche reader, and a single overhead light'

// Models to bench (NIM ids from server.js LLM_PROVIDERS).
const DEFAULT_MODELS = [
  'default',                    // Gemma 4 31B (self-hosted)
  'nim-deepseek-v4-pro',
  'nim-deepseek-v4-flash',
  'nim-kimi-k2.6',
  'nim-kimi-k2-instruct',
  'nim-minimax-m2.7',
  'nim-glm-5.1',
  'nim-nemotron-3-super',
  'nim-qwen3.5-397b',
  'nim-gpt-oss-120b',
]
const MODELS = args.models
  ? String(args.models).split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_MODELS

console.log(`[bench] bridge=${BRIDGE}`)
console.log(`[bench] room=${TEST_ROOM_ID} trials=${TRIALS}`)
console.log(`[bench] models=${MODELS.join(', ')}`)

// ── Helpers ──────────────────────────────────────────────────────
function fmt(n, p = 2) { return Number.isFinite(n) ? n.toFixed(p) : '—' }

// Deterministic seed — every model gets the same input. PUT directly so
// we don't depend on an LLM bootstrap (which can itself fail).
const SEED_LAYOUT = {
  version: 1,
  id: TEST_ROOM_ID,
  name: 'Quiet Records Archive',
  description: 'A small windowless archive room with metal filing cabinets and a single microfiche reader.',
  vibe: 'The numbers are filed, not understood.',
  category: 'work',
  dimensions: { width: 5, depth: 4, height: 3 },
  palette: {
    wall: '#d8cdb4',
    floor: '#5a7a72',
    accent: '#7aa884',
    ceiling: '#e8e4d8',
    trim: '#6a4a32',
  },
  materials: {},
  lighting: {
    fluorescent: { color: '#e8eef0', intensity: 0.55 },
    accent: { color: '#7aa884', intensity: 0.45, positions: [] },
  },
  fluxPrompt: 'A wide 3/4-angle interior shot of a 1980s corporate records archive. Three olive-green metal filing cabinets line the back wall. A small wooden desk with a chunky microfiche reader sits in the centre. A green banker\'s desk lamp glows softly. Beige walls, low-pile teal carpet, one fluorescent ceiling panel. Photorealistic, cinematic, no people, no text.',
  proposedProps: [
    { id: 'filing-cabinet-left', kind: 'cabinet', prompt: 'olive-green metal four-drawer filing cabinet' },
    { id: 'filing-cabinet-middle', kind: 'cabinet', prompt: 'olive-green metal four-drawer filing cabinet' },
    { id: 'filing-cabinet-right', kind: 'cabinet', prompt: 'olive-green metal four-drawer filing cabinet' },
    { id: 'microfiche-desk', kind: 'desk', prompt: 'small wooden desk' },
    { id: 'microfiche-reader', kind: 'machine', prompt: 'beige chunky microfiche reader machine' },
    { id: 'desk-chair', kind: 'chair', prompt: 'tubular-frame swivel office chair, teal cloth' },
    { id: 'banker-lamp', kind: 'lamp', prompt: 'green-glass banker\'s desk lamp with brass base' },
    { id: 'fluorescent-panel', kind: 'fixture', prompt: 'recessed fluorescent ceiling light panel' },
  ],
  props: [],
  seededFrom: 'bench',
}

async function ensureTestRoom() {
  const r = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(TEST_ROOM_ID)}/layout`)
  if (r.ok) {
    const j = await r.json()
    if (Array.isArray(j.layout?.proposedProps) && j.layout.proposedProps.length) {
      console.log(`[bench] reusing existing test room (${j.layout.proposedProps.length} proposedProps)`)
      return j.layout
    }
  }
  console.log(`[bench] writing deterministic seed via PUT`)
  const put = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(TEST_ROOM_ID)}/layout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SEED_LAYOUT),
  })
  if (!put.ok) {
    const body = await put.text().catch(() => '')
    throw new Error(`PUT seed failed: ${put.status}: ${body.slice(0, 200)}`)
  }
  return SEED_LAYOUT
}

async function consumeSse(res) {
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let lastError = null
  let donePayload = null
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
      if (eventType === 'done') donePayload = parsed
      else if (eventType === 'error') lastError = parsed.error || 'stream error'
    }
  }
  if (lastError) throw new Error(lastError)
  return donePayload
}

// Default fallback size used by reconcileWithProposedProps in the bridge
// when the LLM dropped a prop entirely. We use this signature to count
// "synthesised" vs "model-placed" props.
const FALLBACK_SIZE = { w: 0.6, h: 0.7, d: 0.6 }
function isFallbackPlaced(p) {
  return p.size?.w === FALLBACK_SIZE.w
    && p.size?.h === FALLBACK_SIZE.h
    && p.size?.d === FALLBACK_SIZE.d
    && p.position?.y === 0
    && p.rotation_y === 0
}

async function runTrial(providerId, baselineLayout) {
  const t0 = Date.now()
  const stream = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(TEST_ROOM_ID)}/layout/from-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId }),
  })
  let streamErr = null
  try { await consumeSse(stream) }
  catch (err) { streamErr = err.message || String(err) }
  const elapsedMs = Date.now() - t0

  if (streamErr) {
    return { ok: false, elapsedMs, validity: 'stream-error', errors: [streamErr] }
  }

  // Read the saved layout — bridge has reconciled, so layout always
  // *exists*. We score by validity + how many proposedProps the model
  // actually placed (non-fallback size).
  const r = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(TEST_ROOM_ID)}/layout`)
  if (!r.ok) {
    return { ok: false, elapsedMs, validity: 'no-layout', errors: [`HTTP ${r.status}`] }
  }
  const j = await r.json()
  const layout = j.layout
  const v = validateLayout(layout)

  const totalProposed = baselineLayout.proposedProps?.length ?? 0
  const props = layout.props || []
  const placed = props.filter((p) => !isFallbackPlaced(p)).length
  const placementRate = totalProposed ? placed / totalProposed : 0

  return {
    ok: v.ok,
    elapsedMs,
    validity: v.ok ? 'valid' : 'invalid',
    schemaErrors: v.errors,
    schemaWarnings: v.warnings,
    propCount: props.length,
    placed,
    totalProposed,
    placementRate,
    layoutSize: JSON.stringify(layout).length,
  }
}

// ── Main ─────────────────────────────────────────────────────────
;(async () => {
  const baseline = await ensureTestRoom()
  const proposed = baseline.proposedProps || []
  console.log(`[bench] proposedProps=${proposed.length}: ${proposed.map((p) => p.id).join(', ')}\n`)

  const summary = []
  for (const providerId of MODELS) {
    console.log(`\n── ${providerId} ──`)
    const trials = []
    for (let i = 0; i < TRIALS; i += 1) {
      process.stdout.write(`  trial ${i + 1}/${TRIALS} … `)
      try {
        const result = await runTrial(providerId, baseline)
        const valid = result.ok ? '✓' : '✗'
        const placeMsg = `placed ${result.placed ?? '?'}/${result.totalProposed ?? '?'}`
        process.stdout.write(`${valid} ${placeMsg} in ${(result.elapsedMs / 1000).toFixed(1)}s\n`)
        trials.push(result)
      } catch (err) {
        process.stdout.write(`✗ ${err.message}\n`)
        trials.push({ ok: false, validity: 'fatal', errors: [err.message], elapsedMs: 0 })
      }
    }
    // Aggregate
    const succ = trials.filter((t) => t.ok).length
    const placeAvg = trials.reduce((s, t) => s + (t.placementRate || 0), 0) / Math.max(1, trials.length)
    const elapsedAvg = trials.reduce((s, t) => s + (t.elapsedMs || 0), 0) / Math.max(1, trials.length)
    summary.push({
      providerId,
      successRate: succ / trials.length,
      placementRate: placeAvg,
      elapsedAvgS: elapsedAvg / 1000,
      trials,
    })
  }

  // ── Summary table ──
  summary.sort((a, b) => {
    // Rank by success * placement, then by speed.
    const sa = a.successRate * 0.6 + a.placementRate * 0.4
    const sb = b.successRate * 0.6 + b.placementRate * 0.4
    if (sa !== sb) return sb - sa
    return a.elapsedAvgS - b.elapsedAvgS
  })

  console.log('\n## Results\n')
  console.log('| Rank | Model | Success | Placement | Avg time | Notes |')
  console.log('|---|---|---|---|---|---|')
  summary.forEach((s, i) => {
    const failures = s.trials.filter((t) => !t.ok)
    const noteParts = []
    if (failures.length) {
      const reasons = [...new Set(failures.flatMap((f) => f.errors || [f.validity]))]
        .map((r) => String(r).slice(0, 60))
      noteParts.push(reasons.join('; '))
    }
    const notes = noteParts.join('; ') || '—'
    console.log(
      `| ${i + 1} | \`${s.providerId}\` | ${(s.successRate * 100).toFixed(0)}% | ${(s.placementRate * 100).toFixed(0)}% | ${fmt(s.elapsedAvgS, 1)}s | ${notes} |`,
    )
  })

  console.log(`\nWinner: ${summary[0].providerId}`)
  process.exit(0)
})().catch((err) => {
  console.error('[bench] fatal:', err)
  process.exit(1)
})

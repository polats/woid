#!/usr/bin/env node
/**
 * End-to-end smoke for 10 diverse rooms. For each prompt:
 *   1. POST /rooms/:id/initial          — name, desc, vibe, palette, flux, proposed_props
 *   2. POST /rooms/:id/layout/from-prompt — dimensions + positioned props
 *   3. validateLayout(savedLayout)      — frontend strict validation
 *
 * Failures at any stage are logged with the raw response so we can see
 * what the LLM actually emitted. Final report = pass/fail per stage +
 * the error list per failed run.
 *
 * Usage: node scripts/test-10-rooms.mjs
 *        node scripts/test-10-rooms.mjs --provider=nim-qwen3.5-397b
 *        node scripts/test-10-rooms.mjs --concept=false   # skip FLUX images
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
const SKIP_CONCEPT = args.concept === 'false' || args.concept === false
const LOG_PATH = args.log || '/tmp/test-10-rooms.log'

const PROMPTS = [
  'a windowless server room with humming racks of beige equipment',
  'a 1970s avocado and harvest-gold break room with formica tables',
  'a hunter-green executive corner office with cognac leather chairs',
  'a clinical pale-lilac wellness session room with a single chair',
  'a long pneumatic-tube mailroom with brass fittings and pigeonholes',
  'a fluorescent-lit cubicle farm with low partitions and CRT terminals',
  'a dim records archive with oxide-red filing cabinets and microfiche',
  'a stark testing floor with one unmarked pedestal in the centre',
  'a Lumon-style oat-and-mint refinement bay with four desks facing inward',
  'a cold-grey institutional reception with a brass bell and one fern',
]

const slug = (s, i) =>
  `e2e-${String(i + 1).padStart(2, '0')}-`
  + s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)

async function consumeSse(res) {
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body })
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let donePayload = null
  let errorMsg = null
  let lastTokens = ''
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
      else if (eventType === 'error') errorMsg = parsed.error || 'stream error'
      else if (eventType === 'token') lastTokens += parsed.text || ''
    }
  }
  return { donePayload, errorMsg, lastTokens }
}

async function fetchLayout(roomId) {
  const r = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(roomId)}/layout`)
  if (!r.ok) return null
  const j = await r.json()
  return j.layout
}

async function runOne(idx, prompt) {
  const roomId = slug(prompt, idx)
  const result = {
    idx, roomId, prompt,
    initial: { ok: false, ms: 0 },
    fromPrompt: { ok: false, ms: 0 },
    validate: { ok: false, errors: [], warnings: [] },
  }

  // ── Stage 1: initial concept ─────────────────────────────────
  const t0 = Date.now()
  try {
    const r = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(roomId)}/initial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, providerId: PROVIDER, skipConcept: SKIP_CONCEPT }),
    })
    const { donePayload, errorMsg, lastTokens } = await consumeSse(r)
    result.initial.ms = Date.now() - t0
    if (errorMsg) {
      result.initial.error = errorMsg
      result.initial.lastTokens = lastTokens.slice(-1500)
      return result
    }
    if (!donePayload) {
      result.initial.error = 'stream ended without done'
      result.initial.lastTokens = lastTokens.slice(-1500)
      return result
    }
    result.initial.ok = true
    result.initial.fluxPrompt = donePayload.fluxPrompt
  } catch (err) {
    result.initial.error = err.message
    return result
  }

  // ── Stage 2: layout from prompt ──────────────────────────────
  await new Promise((r) => setTimeout(r, 4000)) // dodge NIM 429 between same-provider calls
  const t1 = Date.now()
  try {
    const r = await fetch(`${BRIDGE}/rooms/${encodeURIComponent(roomId)}/layout/from-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: PROVIDER }),
    })
    const { donePayload, errorMsg, lastTokens } = await consumeSse(r)
    result.fromPrompt.ms = Date.now() - t1
    if (errorMsg) {
      result.fromPrompt.error = errorMsg
      result.fromPrompt.lastTokens = lastTokens.slice(-1500)
      return result
    }
    if (!donePayload) {
      result.fromPrompt.error = 'stream ended without done'
      result.fromPrompt.lastTokens = lastTokens.slice(-1500)
      return result
    }
    result.fromPrompt.ok = true
    result.fromPrompt.propCount = donePayload.propCount
  } catch (err) {
    result.fromPrompt.error = err.message
    return result
  }

  // ── Stage 3: frontend validation ─────────────────────────────
  try {
    const layout = await fetchLayout(roomId)
    if (!layout) {
      result.validate.errors = ['layout not found on disk']
      return result
    }
    const v = validateLayout(layout)
    result.validate.ok = v.ok
    result.validate.errors = v.errors
    result.validate.warnings = v.warnings
    result.validate.savedDimensions = layout.dimensions
    result.validate.savedPropCount = (layout.props || []).length
    result.validate.proposedCount = (layout.proposedProps || []).length
  } catch (err) {
    result.validate.errors = [err.message]
  }
  return result
}

;(async () => {
  console.log(`[e2e] bridge=${BRIDGE} provider=${PROVIDER} concept=${!SKIP_CONCEPT}`)
  console.log(`[e2e] running ${PROMPTS.length} rooms sequentially…\n`)
  const results = []
  for (let i = 0; i < PROMPTS.length; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 4000)) // dodge NIM 429
    process.stdout.write(`  ${String(i + 1).padStart(2, '0')}. ${PROMPTS[i].slice(0, 50).padEnd(50, ' ')}`)
    const r = await runOne(i, PROMPTS[i])
    results.push(r)
    const initFlag = r.initial.ok ? '✓' : '✗'
    const layoutFlag = r.fromPrompt.ok ? '✓' : '✗'
    const validFlag = r.validate.ok ? '✓' : (r.validate.errors.length ? '✗' : '·')
    const props = r.validate.savedPropCount != null
      ? `${r.validate.savedPropCount}/${r.validate.proposedCount}`
      : '—'
    process.stdout.write(`  init=${initFlag}  layout=${layoutFlag}  valid=${validFlag}  props=${props}\n`)
  }

  // ── Summary ──────────────────────────────────────────────────
  const initPass = results.filter((r) => r.initial.ok).length
  const layoutPass = results.filter((r) => r.fromPrompt.ok).length
  const validPass = results.filter((r) => r.validate.ok).length

  console.log('\n## Stage pass-rates')
  console.log(`  initial:        ${initPass}/${results.length}`)
  console.log(`  from-prompt:    ${layoutPass}/${results.length}`)
  console.log(`  schema valid:   ${validPass}/${results.length}\n`)

  // ── Failure detail ──────────────────────────────────────────
  const failures = results.filter((r) => !r.initial.ok || !r.fromPrompt.ok || !r.validate.ok)
  if (failures.length) {
    console.log(`## Failures (${failures.length})\n`)
    for (const f of failures) {
      console.log(`### ${f.roomId} — "${f.prompt}"`)
      if (!f.initial.ok) {
        console.log(`  ✗ initial: ${f.initial.error}`)
        if (f.initial.lastTokens) console.log(`    last tokens: ${f.initial.lastTokens.slice(0, 200).replace(/\n/g, ' ')}…`)
      } else if (!f.fromPrompt.ok) {
        console.log(`  ✗ from-prompt: ${f.fromPrompt.error}`)
        if (f.fromPrompt.lastTokens) console.log(`    last tokens: ${f.fromPrompt.lastTokens.slice(0, 200).replace(/\n/g, ' ')}…`)
      } else if (!f.validate.ok) {
        console.log(`  ✗ schema validation:`)
        for (const e of f.validate.errors.slice(0, 8)) console.log(`      - ${e}`)
        if (f.validate.warnings.length) {
          console.log(`    warnings (${f.validate.warnings.length}):`)
          for (const w of f.validate.warnings.slice(0, 5)) console.log(`      · ${w}`)
        }
      }
      console.log('')
    }
  }

  // ── Warnings even on passes ─────────────────────────────────
  const withWarnings = results.filter((r) => r.validate.ok && r.validate.warnings.length)
  if (withWarnings.length) {
    console.log(`## Passing rooms with warnings (${withWarnings.length})\n`)
    for (const r of withWarnings) {
      console.log(`  ${r.roomId}: ${r.validate.warnings.length} warning${r.validate.warnings.length === 1 ? '' : 's'}`)
      for (const w of r.validate.warnings.slice(0, 3)) console.log(`    · ${w}`)
    }
    console.log('')
  }

  writeFileSync(LOG_PATH, JSON.stringify(results, null, 2))
  console.log(`Detail written to ${LOG_PATH}`)
})().catch((err) => {
  console.error('[e2e] fatal:', err)
  process.exit(1)
})

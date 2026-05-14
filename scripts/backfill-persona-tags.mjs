#!/usr/bin/env node
/**
 * Retroactively populate `specialty` and `personality` on existing
 * characters whose persona was generated before the bridge stored
 * those fields explicitly.
 *
 * For each target character:
 *   1. Read their `about` text from the bridge.
 *   2. Ask local Gemma (OpenAI-compat at localhost:18080) to extract
 *      a JSON pair `{ specialty, personality }` from the bio.
 *   3. PATCH the character so the new fields are persisted.
 *
 * Defaults to the 40 most recently-created characters that have an
 * `about` but no `specialty` field. Override with --limit, --all,
 * --name, --manifest, or --force.
 *
 * Usage:
 *   node scripts/backfill-persona-tags.mjs
 *   node scripts/backfill-persona-tags.mjs --limit=10
 *   node scripts/backfill-persona-tags.mjs --all
 *   node scripts/backfill-persona-tags.mjs --manifest=e2e-runs/cast-batch-2.json
 *   node scripts/backfill-persona-tags.mjs --force            # rewrite even if tags already set
 *   node scripts/backfill-persona-tags.mjs --name='^Zora'
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const GEMMA = process.env.GEMMA_URL || 'http://localhost:18080'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')))
const kv = Object.fromEntries(
  args.filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)] }),
)
const force = flags.has('--force')
const all = flags.has('--all')
const limit = kv.limit ? parseInt(kv.limit, 10) : (all ? Infinity : 40)
const nameFilter = kv.name ? new RegExp(kv.name, 'i') : null
const manifestPath = kv.manifest ? resolve(kv.manifest) : null

const SYSTEM = `You extract structured tags from short character bios for a
Severance-flavoured corporate-mystery game. Given a bio, return a JSON
object with exactly two fields:

  - "specialty": the character's role / job title, 1-4 words, title-case,
    no trailing punctuation. Pulled DIRECTLY from the bio — don't invent.
  - "personality": a short personality tag, 2-4 words, title-case or
    sentence-case, NO trailing period. Captures their disposition, not
    their appearance.

Respond ONLY with valid JSON. No markdown, no code fences, no commentary.

Example:
  Bio: "Late 50s compliance officer. Tall, slender, charcoal grey trouser
        suit, shoulder-length grey bob, wire-rimmed glasses. Stern."
  → {"specialty":"Compliance Officer","personality":"Stern"}`

async function gemmaTags(about) {
  const res = await fetch(`${GEMMA}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Bio: ${about}` },
      ],
      temperature: 0.2,
      max_tokens: 120,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`gemma HTTP ${res.status}`)
  const j = await res.json()
  const raw = j.choices?.[0]?.message?.content ?? ''
  // Strip code fences if present.
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (m ? m[1] : raw).trim()
  // Lift the first JSON object out of the response.
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error(`no JSON in: ${raw.slice(0, 120)}`)
  const obj = JSON.parse(candidate.slice(start, end + 1))
  const specialty = clean(obj.specialty)
  const personality = clean(obj.personality)
  if (!specialty && !personality) throw new Error('no tags extracted')
  return { specialty, personality }
}

function clean(v) {
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/\.\s*$/, '')
  if (!s) return null
  return s.length > 48 ? s.slice(0, 46).trim() + '…' : s
}

async function listCharacters() {
  const r = await fetch(`${BRIDGE}/characters`)
  if (!r.ok) throw new Error(`list characters HTTP ${r.status}`)
  return (await r.json()).characters
}

async function fetchCharacter(pubkey) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}`)
  if (!r.ok) throw new Error(`fetch char HTTP ${r.status}`)
  return r.json()
}

async function patchCharacter(pubkey, body) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`patch HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`)
}

// ─── Main ───────────────────────────────────────────────────────────

console.log(`Bridge: ${BRIDGE}  ·  Gemma: ${GEMMA}`)

let candidates = []
if (manifestPath) {
  if (!existsSync(manifestPath)) {
    console.error(`No manifest at ${manifestPath}`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  candidates = manifest.characters ?? []
  console.log(`Manifest: ${manifestPath}  ·  ${candidates.length} entries`)
} else {
  const all = await listCharacters()
  // Newest first — `createdAt` is monotonic per-character on the bridge.
  candidates = all
    .filter((c) => c.about && (force || !c.specialty || !c.personality))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  console.log(`Found ${candidates.length} characters with about + missing tags`)
}

if (nameFilter) candidates = candidates.filter((c) => nameFilter.test(c.name || ''))
candidates = candidates.slice(0, limit)

console.log(`Processing ${candidates.length} characters${force ? ' (--force)' : ''}\n`)

let ok = 0, fail = 0
const t0 = Date.now()
for (const entry of candidates) {
  const start = Date.now()
  const pubkey = entry.pubkey
  // Re-fetch full record so we have the about even if the list response
  // truncated it. Also gives us current specialty/personality to skip.
  let char
  try { char = await fetchCharacter(pubkey) }
  catch (err) { console.log(`  ✗ ${entry.name}: ${err.message}`); fail++; continue }

  if (!force && char.specialty && char.personality) {
    console.log(`  · ${char.name}: already tagged, skipping`)
    continue
  }
  if (!char.about) {
    console.log(`  · ${char.name}: no about, skipping`)
    continue
  }

  console.log(`=== ${char.name}  (${pubkey.slice(0, 12)}…) ===`)
  try {
    const { specialty, personality } = await gemmaTags(char.about)
    await patchCharacter(pubkey, { specialty, personality })
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  ✓ specialty="${specialty}"  personality="${personality}"  ${dt}s\n`)
    ok++
  } catch (err) {
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  ✗ ${err.message} (${dt}s)\n`)
    fail++
  }
}

const total = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`Done. ${ok} ok, ${fail} failed. Total ${total}s.`)
process.exit(fail > 0 ? 1 : 0)

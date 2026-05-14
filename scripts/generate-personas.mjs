#!/usr/bin/env node
/**
 * STEP 1 of the cast pipeline: personas only.
 *
 * Generates N character personas (split male/female) via either NIM
 * or local Gemma, using the bridge's `player-persona` system prompt.
 * Each one becomes a real character on the bridge with name + about
 * set, but no avatar / tpose / mesh / rig — those are later steps.
 *
 * Why split this out: the user reviews names + bios on the frontend
 * BEFORE we burn time on per-character image + mesh + rig pipelines.
 *
 * Each persona gets a short "seed hint" sampled from a varied pool
 * so we don't end up with 16 receptionists. The hint is short — the
 * LLM fills in everything else (name, exact appearance, personality
 * tag) via the registered player-persona prompt.
 *
 * Outputs a manifest at e2e-runs/cast-manifest.json so downstream
 * steps (avatars, tposes, mesh, rig) know which pubkeys are "the
 * cast" without sweeping up legacy characters.
 *
 * Usage:
 *   node scripts/generate-personas.mjs                       # 16, 8M/8F, NIM
 *   node scripts/generate-personas.mjs --count=12            # 12, 6M/6F, NIM
 *   node scripts/generate-personas.mjs --males=6 --females=4 # 10 total
 *   node scripts/generate-personas.mjs --source=gemma        # local Gemma instead
 *   node scripts/generate-personas.mjs --manifest=path.json  # custom output
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const GEMMA_URL = process.env.GEMMA_URL || 'http://localhost:18080'

// ─── CLI flags ──────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flagSet = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')))
const kv = Object.fromEntries(
  args.filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)] }),
)
const count = kv.count ? parseInt(kv.count, 10) : null
const males = kv.males != null
  ? parseInt(kv.males, 10)
  : (count != null ? Math.ceil(count / 2) : 8)
const females = kv.females != null
  ? parseInt(kv.females, 10)
  : (count != null ? Math.floor(count / 2) : 8)
const source = (kv.source || 'nim').toLowerCase()           // 'nim' | 'gemma'
if (!['nim', 'gemma'].includes(source)) {
  console.error(`--source must be 'nim' or 'gemma' (got ${source})`)
  process.exit(1)
}
const manifestPath = resolve(
  kv.manifest || 'e2e-runs/cast-manifest.json',
)

// ─── NIM (optional) ─────────────────────────────────────────────────

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const NIM_MODEL_ID = process.env.NIM_PERSONA_MODEL || 'nim-llama-3.1-70b'
const NIM_MODELS = {
  'nim-llama-3.1-70b':  'meta/llama-3.1-70b-instruct',
  'nim-llama-3.1-405b': 'meta/llama-3.1-405b-instruct',
  'nim-qwen3-next-80b': 'qwen/qwen3-next-80b-a3b-instruct',
  'nim-glm-5.1':        'zai-org/glm-5.1',
}
function nimModelPath() {
  return NIM_MODELS[NIM_MODEL_ID] || 'meta/llama-3.1-70b-instruct'
}
function loadNimKey() {
  const envFile = '/home/paul/projects/woid/agent-sandbox/.env'
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*NVIDIA_NIM_API_KEY\s*=\s*(.+?)\s*$/)
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  throw new Error('NVIDIA_NIM_API_KEY not found in agent-sandbox/.env')
}
const NIM_KEY = source === 'nim' ? loadNimKey() : null

// Keep --clean alias for back-compat (older invocations may pass it).
const flags = flagSet

// Varied seed pool — each entry is a single role/age/decade hint.
// The script samples from this list based on the requested male /
// female counts. Hints are short; the registered player-persona
// prompt does the heavy lifting (name, exact appearance, vibe).
const MALE_HINTS = [
  'elderly executive, dark wool suit with bow tie, late 60s',
  'wiry archivist, beard and round glasses, 30s',
  'data sorter, balding with horseshoe of hair, worried squint, early 50s',
  'cafeteria manager, heavyset, ruddy face, apron, mid 50s',
  'logistics records clerk, athletic build, beige short-sleeve work shirt, 40s',
  'mailroom clerk, slim, side-parted hair and a slim tie, late 20s',
  'janitorial supervisor, sturdy build, work coveralls, late 50s',
  'telex operator, slight build, cardigan over collared shirt, 30s',
  'photocopy attendant, beige sweater vest, parted hair, mid 40s',
  'tape librarian, button-up cardigan, glasses, early 40s',
  'maintenance tech, sturdy, mustache, name-tag overalls, 50s',
  'office worker, slim grey tie, ironed shirt, late 20s',
]
const FEMALE_HINTS = [
  'reception desk supervisor, 1980s bouffant and twin-set, warm but no-nonsense, late 40s',
  'tape librarian, bohemian, frizzy auburn hair and tortoiseshell glasses, early 30s',
  'compliance officer, severe grey skirt suit, glasses on a chain, tall, late 50s',
  'mailroom supervisor, sharp black bob, navy blazer over white blouse, early 40s',
  'cleaning supervisor, mauve smock, low grey ponytail, sturdy, early 60s',
  'drafting technician, hair in a long braid, pencil behind ear, mid 30s',
  'microfilm clerk, soft cardigan and beaded chain glasses, mid 50s',
  'logistics records reviewer, short blonde undercut, navy work clothes, late 20s',
  'cafeteria server, hairnet over short curls, apron over patterned blouse, 40s',
  'office clerk, slim wool dress, cat-eye glasses, late 30s',
  'archives supervisor, grey wavy hair, blazer over collared shirt, 50s',
  'lactation room attendant, sage cardigan, gentle smile, soft shoes, 30s',
]

// Build the actual seed list from the requested split.
function buildSeeds() {
  const seeds = []
  for (let i = 0; i < males; i++) {
    seeds.push(['male', MALE_HINTS[i % MALE_HINTS.length]])
  }
  for (let i = 0; i < females; i++) {
    seeds.push(['female', FEMALE_HINTS[i % FEMALE_HINTS.length]])
  }
  return seeds
}
const SEEDS = buildSeeds()

// ─── Bridge prompt fetch + Gemma persona ────────────────────────────

let _systemPromptCache = null
async function loadSystemPrompt() {
  if (_systemPromptCache) return _systemPromptCache
  const r = await fetch(`${BRIDGE}/v1/prompts/player-persona`)
  if (!r.ok) throw new Error(`fetch player-persona: HTTP ${r.status}`)
  const j = await r.json()
  _systemPromptCache = j.text
  return j.text
}

// Dispatch to the configured LLM.
async function llmPersona(seedHint, gender, sets) {
  if (source === 'nim') return nimPersona(seedHint, gender, sets)
  return gemmaPersona(seedHint, gender, sets)
}

async function gemmaPersona(seedHint, gender, { avoidFirstNames, avoidLastNames }) {
  const sys = await loadSystemPrompt()
  const avoidLine = (avoidFirstNames.size || avoidLastNames.size)
    ? `\n\nDO NOT use any of these already-taken names. First names already used: ${[...avoidFirstNames].join(', ') || 'none'}. Last names already used: ${[...avoidLastNames].join(', ') || 'none'}. Pick a completely different first AND last name.`
    : ''
  const user =
    `Generate a fresh ${gender} character. Seed hint: ${seedHint}.${avoidLine}\n\n` +
    `Return ONLY a valid JSON object with keys "name" and "about". No markdown, no code fences, no commentary.`
  const r = await fetch(`${GEMMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma-4-e4b-it',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 0.95, top_p: 0.95, max_tokens: 800,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!r.ok) throw new Error(`gemma: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  const raw = j.choices?.[0]?.message?.content ?? ''
  let parsed; try { parsed = JSON.parse(raw) } catch {
    const m = raw.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]) } catch {}
  }
  if (!parsed?.name || !parsed?.about) throw new Error(`malformed JSON: ${raw.slice(0, 200)}`)
  return parsed
}

async function nimPersona(seedHint, gender, { avoidFirstNames, avoidLastNames }) {
  const sys = await loadSystemPrompt()
  const avoidLine = (avoidFirstNames.size || avoidLastNames.size)
    ? `\n\nDO NOT use any of these already-taken names. First names already used: ${[...avoidFirstNames].join(', ') || 'none'}. Last names already used: ${[...avoidLastNames].join(', ') || 'none'}. Pick a completely different first AND last name.`
    : ''
  const user =
    `Generate a fresh ${gender} character. Seed hint: ${seedHint}.${avoidLine}\n\n` +
    `Return ONLY a valid JSON object with keys "name" and "about". No markdown, no code fences, no commentary.`
  const r = await fetch(NIM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NIM_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: nimModelPath(),
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 1.05, top_p: 0.95, max_tokens: 600,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!r.ok) throw new Error(`nim: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  const raw = j.choices?.[0]?.message?.content ?? ''
  let parsed
  try { parsed = JSON.parse(raw) } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) try { parsed = JSON.parse(m[0]) } catch {}
  }
  if (!parsed?.name || !parsed?.about) {
    throw new Error(`malformed JSON: ${raw.slice(0, 200)}`)
  }
  return parsed
}

// Up to N retries to land a (first, last) name pair that hasn't been
// used yet. NIM is told which names to avoid via the user message so
// it doesn't have to guess.
async function uniquePersona(seedHint, gender, sets, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    const persona = await llmPersona(seedHint, gender, sets)
    const parts = persona.name.trim().split(/\s+/)
    const first = parts[0]?.toLowerCase()
    const last = parts.slice(1).join(' ').toLowerCase()
    if (!first || !last) continue
    if (sets.avoidFirstNames.has(first) || sets.avoidLastNames.has(last)) continue
    sets.avoidFirstNames.add(first)
    sets.avoidLastNames.add(last)
    return persona
  }
  throw new Error(`could not get a unique name after ${maxRetries} attempts`)
}

// ─── Bridge mint + patch ────────────────────────────────────────────

async function mint(name) {
  const r = await fetch(`${BRIDGE}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, kind: 'player' }),
  })
  if (!r.ok) throw new Error(`mint: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

async function patchAbout(pubkey, about) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ about }),
  })
  if (!r.ok) throw new Error(`patch about: HTTP ${r.status}`)
}

// ─── Probe ──────────────────────────────────────────────────────────

async function preflight() {
  try {
    const r = await fetch(`${BRIDGE}/v1/health/ready`, { signal: AbortSignal.timeout(3000) })
    console.log(`  ✓ bridge: ${BRIDGE} (status ${r.status})`)
  } catch (err) {
    console.error(`  ✗ bridge unreachable: ${err.message}`)
    process.exit(1)
  }
  if (source === 'nim') {
    console.log(`  ✓ NIM: ${NIM_MODEL_ID} (${nimModelPath()}), key length ${NIM_KEY.length}`)
  } else {
    try {
      const r = await fetch(`${GEMMA_URL}/v1/models`, { signal: AbortSignal.timeout(3000) })
      if (!r.ok) throw new Error(`status ${r.status}`)
      console.log(`  ✓ Gemma: ${GEMMA_URL}`)
    } catch (err) {
      console.error(`  ✗ Gemma unreachable: ${err.message}`)
      process.exit(1)
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────

console.log('Preflight:')
await preflight()

console.log(`\nGenerating ${SEEDS.length} personas (${males}M + ${females}F)  ·  source=${source}\n`)
const t0 = Date.now()
const ok = []
const failed = []
const sets = { avoidFirstNames: new Set(), avoidLastNames: new Set() }

for (const [gender, seed] of SEEDS) {
  const start = Date.now()
  try {
    const persona = await uniquePersona(seed, gender, sets)
    const m = await mint(persona.name)
    await patchAbout(m.pubkey, persona.about)
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  ✓ [${gender}]  ${persona.name.padEnd(28)} ${m.pubkey.slice(0,12)}…  ${dt}s`)
    console.log(`              about: ${persona.about.slice(0, 120)}${persona.about.length > 120 ? '…' : ''}`)
    ok.push({
      name: persona.name, about: persona.about,
      pubkey: m.pubkey, npub: m.npub, gender,
    })
  } catch (err) {
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  ✗ [${gender}]  seed="${seed.slice(0, 40)}…" failed in ${dt}s: ${err.message.slice(0, 200)}`)
    failed.push({ gender, seed, error: err.message })
  }
}

const total = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\nDone. ${ok.length} ok, ${failed.length} failed. Total ${total}s.`)

// Write the manifest so downstream steps target just this batch.
if (ok.length) {
  const manifest = {
    createdAt: new Date().toISOString(),
    source,
    males, females,
    characters: ok,
  }
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`\nManifest written to ${manifestPath}`)
  console.log('Next step:  node scripts/generate-avatars.mjs')
}
process.exit(failed.length > 0 ? 1 : 0)

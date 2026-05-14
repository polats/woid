#!/usr/bin/env node
/**
 * Generate the trailer cast using a mix of LOCAL and CLOUD services,
 * pipelined so cloud TRELLIS runs in parallel with the next character's
 * local stages.
 *
 *   persona ─ local Gemma  (localhost:18080, llama.cpp)
 *   mint    ─ bridge POST /characters
 *   about   ─ bridge PATCH /characters/:pubkey
 *   avatar  ─ local ComfyUI flux.1-schnell  (localhost:8191)
 *             written into the bridge's workspace at
 *             /workspace/characters/<npub>/avatar.jpeg
 *   tpose   ─ bridge POST /characters/:pubkey/generate-tpose/stream
 *             (Cloud Run flux.1-kontext-dev with the side-by-side
 *             composite trick — re-implementing locally would
 *             duplicate engineering for no real gain)
 *   mesh    ─ --mesh=cloud → bridge POST /generate-model/stream
 *               (Cloud Run TRELLIS, kicked off async; the loop keeps
 *               doing local stages for the next character while this
 *               runs)
 *             --mesh=local → ComfyUI client.py trellis
 *               (same warm worker as avatar, must run serially)
 *   rig     ─ bridge POST /characters/:pubkey/generate-rig/stream
 *             (UniRig + kimodo-tools chain, all local services)
 *   added   ─ bridge PATCH /characters/:pubkey {added:true}
 *
 * Assumes: bridge, Gemma, comfy-local, UniRig, kimodo-tools all up.
 *
 * Usage:
 *   node scripts/generate-cast-local.mjs                         # default --mesh=cloud
 *   node scripts/generate-cast-local.mjs --mesh=local
 *   node scripts/generate-cast-local.mjs --clean "^Pearl"        # filter + wipe existing
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const GEMMA_URL = process.env.GEMMA_URL || 'http://localhost:18080'
const COMFY_URL = process.env.COMFY_URL || 'http://localhost:8191'
const COMPOSE_FILE = '/home/paul/projects/woid/agent-sandbox/docker-compose.yml'
const COMFY_CLIENT = '/home/paul/projects/google-cloud/gemma-4-self-hosted/comfyui-runpod/client.py'

// ─── CLI ────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')))
const kv = Object.fromEntries(
  args.filter((a) => a.startsWith('--') && a.includes('='))
      .map((a) => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)] }),
)
const positional = args.filter((a) => !a.startsWith('--'))
const meshMode = (kv.mesh || 'cloud').toLowerCase()  // 'cloud' | 'local'
if (!['cloud', 'local'].includes(meshMode)) {
  console.error(`--mesh must be 'cloud' or 'local' (got '${meshMode}')`)
  process.exit(1)
}
const filterRe = positional[0] ? new RegExp(positional[0]) : null

// ─── Cast ───────────────────────────────────────────────────────────
//
// Each entry seeds Gemma — the LLM rewrites it through the registered
// player-persona prompt to produce a clean three-sentence brief in
// the Pearl-Greaves format. Hand-written briefs as guidance, not
// verbatim copy.

const CAST = [
  ['Wayne Boggs',     'male',   'weary 52-year-old data sorter, balding with horseshoe of grey-brown hair, glasses on beaded cord, khaki shirt with thin maroon tie, permanent worried squint'],
  ['Roland Kaye',     'male',   '38-year-old wiry archivist, dark untidy hair, full beard, oval wire-rim glasses, tobacco-stained brown cardigan, beige polo, faded jeans'],
  ['Hiroto Lin',      'male',   'slim 29-year-old East Asian severance-style office worker, jet black hair side part, white button-down shirt with slim grey tie, dark trousers, quietly intense'],
  ['Mort Chevallier', 'male',   'heavyset 55-year-old French cafeteria manager, full grey moustache, ruddy face, balding, white short-sleeve shirt rolled sleeves, brown apron, easy smile'],
  ['Bertram Hess',    'male',   '68-year-old elderly German executive, slight stoop, three-piece dark wool suit with navy bow tie, thinning white hair combed back, half-moon spectacles'],
  ['Otto Spire',      'male',   '45-year-old Black security officer with meticulous handlebar mustache, beige short-sleeve uniform with black tie and brass badge, close-cropped hair, broad shoulders'],
  ['Pearl Greaves',   'female', '49-year-old reception desk supervisor, mint-green wool twin-set with pearl buttons, blonde 1980s bouffant, reading glasses pushed up on head, warm but no-nonsense'],
  ['Esme Plok',       'female', '33-year-old bohemian tape librarian, frizzy auburn hair half tied back, freckles, round tortoiseshell glasses, long olive corduroy skirt, mustard cardigan, clogs'],
  ['Lillian Hwang',   'female', '41-year-old East Asian mailroom supervisor, sharp chin-length black bob side part, navy blazer over white blouse, mid-length grey pencil skirt, low heels'],
  ['Mavis Olcoot',    'female', '57-year-old tall senior compliance officer, severe slate-grey skirt suit, grey hair in tight bun, rimless rectangular glasses on a chain, enamel company-seal pin, stern'],
  ['Theodora Trash',  'female', '62-year-old Black senior cleaning supervisor, sturdy build, mauve smock over charcoal long-sleeve shirt, low grey ponytail, hoop earrings, sensible white sneakers'],
  ['Kit Vanderlaan',  'female', '28-year-old athletic Dutch security analyst, short blonde undercut, navy short-sleeve uniform with shoulder patches, utility belt, sleeveless under-shirt visible at collar'],
]
const wanted = filterRe ? CAST.filter((c) => filterRe.test(c[0])) : CAST

// ─── Probes ─────────────────────────────────────────────────────────

async function probe(label, url, predicate = (r) => r.ok) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!predicate(r)) throw new Error(`status ${r.status}`)
    console.log(`  ✓ ${label}: ${url}`)
    return true
  } catch (err) {
    console.error(`  ✗ ${label} unreachable at ${url} (${err.message})`)
    return false
  }
}

async function preflight() {
  console.log('Probing services:')
  const checks = [
    probe('bridge', `${BRIDGE}/v1/health/ready`, (r) => r.status === 200 || r.status === 404),
    probe('gemma', `${GEMMA_URL}/v1/models`),
    probe('comfy', `${COMFY_URL}/system_stats`),
  ]
  const results = await Promise.all(checks)
  if (results.some((ok) => !ok)) {
    console.error('\nPreflight failed. Start the missing services and retry.')
    console.error('  comfy-local: docker run --rm --gpus all -d --name comfy-local -p 8191:8188 -e SERVE_API_LOCALLY=true polats/comfyui-runpod:latest')
    process.exit(1)
  }
}

// ─── Bridge helpers ─────────────────────────────────────────────────

async function bridgePost(path, body = {}, opts = {}) {
  const r = await fetch(`${BRIDGE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...opts,
  })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
async function bridgePatch(path, body) {
  const r = await fetch(`${BRIDGE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

// Run a streaming SSE endpoint to completion. Returns the final `done`
// event payload, throws on error event.
async function bridgeStream(path, body, label) {
  const res = await fetch(`${BRIDGE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    throw new Error(`${path}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', done = null, error = null, lastStage = null
  while (true) {
    const { value, done: end } = await reader.read()
    if (end) break
    buf += dec.decode(value, { stream: true })
    const events = buf.split(/\n\n/); buf = events.pop() ?? ''
    for (const ev of events) {
      let type = 'message'; const data = []
      for (const line of ev.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (!data.length) continue
      let parsed; try { parsed = JSON.parse(data.join('\n')) } catch { continue }
      if (type === 'done') done = parsed
      else if (type === 'error') error = parsed.error || 'stream error'
      else if (type === 'stage' && parsed.stage !== lastStage) {
        lastStage = parsed.stage
        process.stdout.write(`        ${label}/${parsed.stage}\n`)
      }
    }
  }
  if (error) throw new Error(error)
  return done
}

// Drop bytes into the bridge's workspace via docker exec — the
// pi-bridge container mounts /var/lib/docker/volumes/.../pi-workspace
// as /workspace. We pipe through `cat > <path>` so we don't have to
// fiddle with host-level permissions on a root-owned volume.
function bridgeWriteFile(npub, filename, bytes) {
  return new Promise((resolve, reject) => {
    const target = `/workspace/characters/${npub}/${filename}`
    const proc = spawn('docker', [
      'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'pi-bridge',
      'sh', '-c', `mkdir -p /workspace/characters/${npub} && cat > ${target}`,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })
    proc.on('error', reject)
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`docker exec exit ${code}`)))
    proc.stdin.end(bytes)
  })
}

// ─── Gemma persona ──────────────────────────────────────────────────

let _playerPersonaPromptCache = null
async function loadPlayerPersonaPrompt() {
  if (_playerPersonaPromptCache) return _playerPersonaPromptCache
  const r = await fetch(`${BRIDGE}/v1/prompts/player-persona`)
  const j = await r.json()
  _playerPersonaPromptCache = j.text
  return j.text
}

async function gemmaPersona({ seed, gender }) {
  const sys = await loadPlayerPersonaPrompt()
  const user = `Seed: ${gender} character. ${seed}.\n\nProduce the brief in the format above. Return JSON only.`
  const r = await fetch(`${GEMMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma-4-e4b-it',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 0.85, top_p: 0.95, max_tokens: 400,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!r.ok) throw new Error(`gemma: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  const raw = j.choices?.[0]?.message?.content ?? ''
  // Try to parse; on failure extract the first {...} blob.
  let parsed = null
  try { parsed = JSON.parse(raw) } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) try { parsed = JSON.parse(m[0]) } catch {}
  }
  if (!parsed?.name || !parsed?.about) throw new Error(`gemma returned malformed JSON: ${raw.slice(0, 200)}`)
  return parsed
}

// ─── Comfy helpers ──────────────────────────────────────────────────

function comfyRun(subcommand, extraArgs) {
  const args = [
    COMFY_CLIENT, subcommand,
    '--server', COMFY_URL,
    ...extraArgs,
  ]
  execFileSync('python3', args, { stdio: 'inherit', timeout: 900_000 })
}

async function comfyAvatar({ prompt, outPath, seed }) {
  comfyRun('schnell', [
    '--prompt', prompt,
    '--out', outPath,
    '--seed', String(seed),
  ])
}

async function comfyMesh({ inputImagePath, outPath }) {
  comfyRun('trellis', [
    '--image', inputImagePath,
    '--out', outPath,
  ])
}

// ─── Per-character pipeline ─────────────────────────────────────────

async function runChar({ name, gender, seed, slug }) {
  const charDir = join(tmpdir(), 'woid-cast-local', slug)
  mkdirSync(charDir, { recursive: true })
  const log = (msg) => console.log(`    [${slug}] ${msg}`)

  // 1. Gemma persona
  log('persona (Gemma)…')
  const t0 = Date.now()
  const persona = await gemmaPersona({ seed, gender })
  log(`  → name="${persona.name}" about="${persona.about.slice(0, 80)}…" (${((Date.now()-t0)/1000).toFixed(1)}s)`)

  // 2. Mint on bridge with OUR chosen name (overrides Gemma's, keeping
  //    Gemma's about). Could also use persona.name — but cast cohesion
  //    benefits from stable names across reruns.
  const mint = await bridgePost('/characters', { name, kind: 'player' })
  const { pubkey, npub } = mint
  log(`  pubkey ${pubkey.slice(0, 12)}…  npub ${npub.slice(0, 16)}…`)

  // 3. PATCH the Gemma about.
  await bridgePatch(`/characters/${pubkey}`, { about: persona.about })

  // 4. Avatar via local Comfy schnell.
  log('avatar (Comfy schnell)…')
  const tAvatar = Date.now()
  const avatarPath = join(charDir, 'avatar.png')
  // FLUX schnell wants a prompt; we frame using the same wrapping the
  // bridge's generateAvatarBytes does (square portrait, woid mood).
  const avatarPrompt = [
    `Stylized portrait illustration of: ${persona.name} — ${persona.about}.`,
    'Use the description as thematic inspiration for mood, role, and atmosphere rather than copying specific nouns into the image.',
    'Composition: square 1:1, centered, strong silhouette, clear subject, clean negative space around the figure.',
    'No text, no watermark, no signatures, no UI chrome, no logos.',
  ].join(' ')
  await comfyAvatar({
    prompt: avatarPrompt,
    outPath: avatarPath,
    seed: Math.floor(Math.random() * 2_147_483_647),
  })
  const avatarBytes = readFileSync(avatarPath)
  await bridgeWriteFile(npub, 'avatar.jpeg', avatarBytes)
  log(`  ${avatarBytes.length}B avatar in ${((Date.now()-tAvatar)/1000).toFixed(1)}s`)

  // 5. T-pose via bridge (Cloud Run kontext + side-by-side composite).
  //    Same engineering AgentProfile uses; bypasses NIM safety since
  //    flux.1-kontext is self-hosted.
  log('tpose (bridge → cloud Kontext)…')
  const tTpose = Date.now()
  await bridgeStream(
    `/characters/${pubkey}/generate-tpose/stream`,
    {},
    'tpose',
  )
  log(`  tpose in ${((Date.now()-tTpose)/1000).toFixed(1)}s`)

  // 6. Mesh — strict serial: ALWAYS await inline so the local GPU
  //    never has two contenders at once (e.g. UniRig from the rig
  //    step and Comfy FLUX from the next char's avatar would both
  //    peak at ~13 GB on a 24 GB card). Slower but no OOM crash
  //    surface area.
  log('mesh' + (meshMode === 'cloud' ? ' (cloud TRELLIS)' : ' (Comfy TRELLIS)') + '…')
  const tMesh = Date.now()
  if (meshMode === 'cloud') {
    await bridgeStream(
      `/characters/${pubkey}/generate-model/stream`,
      { backend: 'trellis' },
      'mesh',
    )
  } else {
    const meshPath = join(charDir, 'model.glb')
    const tposeBytes = await fetchBridgeFile(pubkey, 'tpose')
    const tposeLocalPath = join(charDir, 'tpose.png')
    writeFileSync(tposeLocalPath, tposeBytes)
    await comfyMesh({ inputImagePath: tposeLocalPath, outPath: meshPath })
    const meshBytes = readFileSync(meshPath)
    await bridgeWriteFile(npub, 'model.glb', meshBytes)
  }
  log(`  mesh in ${((Date.now()-tMesh)/1000).toFixed(1)}s`)

  // 7. Rig + kimodo via bridge. UniRig peaks the GPU here — we got
  //    through mesh above before reaching this so there's no Comfy
  //    inference running concurrently.
  log('rig + kimodo (bridge)…')
  const tRig = Date.now()
  await bridgeStream(
    `/characters/${pubkey}/generate-rig/stream`,
    { backend: 'trellis', force: true },
    'rig',
  )
  log(`  rig in ${((Date.now()-tRig)/1000).toFixed(1)}s`)

  // 8. Flag `added: true`.
  await bridgePatch(`/characters/${pubkey}`, { added: true })
  log('  ✓ added')
}

async function fetchBridgeFile(pubkey, name) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/${name}`)
  if (!r.ok) throw new Error(`fetch ${name}: HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// ─── --clean ────────────────────────────────────────────────────────

async function cleanByName() {
  const r = await fetch(`${BRIDGE}/characters`)
  const { characters } = await r.json()
  const targets = new Set(wanted.map(([n]) => n))
  const matches = characters.filter((c) => targets.has(c.name))
  if (!matches.length) return
  console.log(`\n--clean: deleting ${matches.length} pre-existing character(s):`)
  for (const c of matches) {
    const dr = await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' })
    console.log(`  ${c.name.padEnd(22)} ${c.pubkey.slice(0,12)}…  ${dr.ok ? 'ok' : 'FAIL'}`)
  }
}

// ─── Main ───────────────────────────────────────────────────────────

await preflight()
if (flags.has('--clean')) await cleanByName()

console.log(`\nGenerating ${wanted.length} character(s)  ·  mesh=${meshMode}\n`)

const t0 = Date.now()
let okCount = 0, failedCount = 0

// Strict serial: every stage of char N completes before char N+1
// starts. Avoids local-GPU contention between UniRig (rig stage of
// char N) and Comfy FLUX (avatar of char N+1), each of which peaks
// ~13 GB on the 24 GB card.
for (const [name, gender, seed] of wanted) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  console.log(`=== ${name} (${gender}) ===`)
  const charStart = Date.now()
  try {
    await runChar({ name, gender, seed, slug })
    okCount += 1
    console.log(`  ✓ ${name} done in ${((Date.now() - charStart) / 1000).toFixed(1)}s\n`)
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}\n`)
    failedCount += 1
  }
}

const total = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`Done. ${okCount} ok, ${failedCount} failed.  Total ${total}s.`)
process.exit(failedCount > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * STEP 3 of the cast pipeline: t-poses.
 *
 * cloud (default) — delegates to the bridge's /generate-tpose/stream
 * endpoint, which composites avatar + tpose_reference, calls the
 * Cloud Run flux-kontext NIM, and crops the right half. All workflow
 * logic stays in the bridge — we just drive it over SSE.
 *
 * local — same workflow, but rebuilt against the local ComfyUI worker:
 *   1. fetch avatar bytes from bridge
 *   2. composite alongside the bridge's tpose_reference.png (via PIL —
 *      scripts/tpose-composite.py composite)
 *   3. call comfyui-runpod client.py kontext on localhost:8191 with the
 *      same TPOSE_PROMPT used by the bridge
 *   4. crop the right half (same PIL helper)
 *   5. write tpose.png back to the bridge volume + PATCH tposeUrl
 *
 * Idempotent: chars that already have tpose.png are skipped unless
 * --force is passed.
 *
 * Usage:
 *   node scripts/generate-tposes.mjs                       # cloud, from manifest
 *   node scripts/generate-tposes.mjs --source=local        # local Comfy kontext
 *   node scripts/generate-tposes.mjs --limit=1             # smoke
 *   node scripts/generate-tposes.mjs --force               # regen
 *   node scripts/generate-tposes.mjs --all-orphans         # any char with avatar but no tpose
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const COMFY_URL = process.env.COMFY_URL || 'http://localhost:8191'
const COMFY_CLIENT = '/home/paul/projects/google-cloud/gemma-4-self-hosted/comfyui-runpod/client.py'
const COMPOSE_FILE = '/home/paul/projects/woid/agent-sandbox/docker-compose.yml'
const COMPOSITE_HELPER = '/home/paul/projects/woid/scripts/tpose-composite.py'
const TPOSE_REFERENCE = '/home/paul/projects/woid/agent-sandbox/pi-bridge/assets/tpose_reference.png'

// Same prompt the bridge uses. Kept in sync with server.js TPOSE_PROMPT.
const TPOSE_PROMPT = [
  'Single full-body T-pose illustration of ONE character matching the portrait.',
  'Only one figure in the image, centered on a plain off-white background.',
  'Same face, hairstyle, and casual everyday clothing as the portrait.',
  'Arms straight out horizontal at shoulder height, palms facing down toward the ground.',
  'Realistic adult human proportions — about 7 to 8 head-heights tall, normal stocky build.',
  'Do NOT stretch or elongate the torso, legs, or neck. NOT thin and tall, NOT anime-stretched.',
  'Arm-span equals body height (the bounding box of the figure is roughly square).',
  'No armor, no weapons.',
  'Do NOT draw multiple figures, multiple views, or a turnaround sheet.',
  'Just one single figure in T-pose, front view.',
].join(' ')

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')))
const kv = Object.fromEntries(
  args.filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)] }),
)
const force = flags.has('--force')
const allOrphans = flags.has('--all-orphans')
const limit = kv.limit ? parseInt(kv.limit, 10) : Infinity
const nameFilter = kv.name ? new RegExp(kv.name, 'i') : null
const source = (kv.source || 'cloud').toLowerCase()
if (!['cloud', 'local'].includes(source)) {
  console.error(`--source must be 'cloud' or 'local' (got ${source})`)
  process.exit(1)
}
const manifestPath = resolve(kv.manifest || 'e2e-runs/cast-manifest.json')

// ─── Bridge helpers ─────────────────────────────────────────────────

async function listCharacters() {
  const r = await fetch(`${BRIDGE}/characters`)
  if (!r.ok) throw new Error(`list characters HTTP ${r.status}`)
  return (await r.json()).characters
}

async function avatarExists(pubkey) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/avatar`, { method: 'HEAD' })
  return r.ok
}

async function tposeExists(pubkey) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/tpose`, { method: 'HEAD' })
  return r.ok
}

async function fetchAvatar(pubkey, outPath) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/avatar`)
  if (!r.ok) throw new Error(`fetch avatar HTTP ${r.status}`)
  writeFileSync(outPath, Buffer.from(await r.arrayBuffer()))
}

function writeTposeToBridge(npub, bytes) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [
      'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'pi-bridge',
      'sh', '-c',
      `mkdir -p /workspace/characters/${npub} && cat > /workspace/characters/${npub}/tpose.png`,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })
    proc.on('error', reject)
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`docker exec exit ${code}`)))
    proc.stdin.end(bytes)
  })
}

// Bridge derives tposeUrl from disk on read, so no PATCH is needed
// once tpose.png lands in the char dir.

// ─── Cloud path: SSE drive of bridge endpoint ───────────────────────

async function generateTposeCloud(pubkey) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/generate-tpose/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(600_000),
  })
  if (!r.ok) throw new Error(`stream HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let lastStage = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
      let event = 'message', data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data = line.slice(6)
      }
      if (!data) continue
      let parsed; try { parsed = JSON.parse(data) } catch { continue }
      if (event === 'stage' && parsed.stage && parsed.stage !== lastStage) {
        lastStage = parsed.stage
        process.stdout.write(`    stage: ${parsed.stage}\n`)
      } else if (event === 'error') {
        throw new Error(parsed.error || 'stream error')
      } else if (event === 'done') {
        return parsed.tposeUrl
      }
    }
  }
  throw new Error('stream ended without done event')
}

// ─── Local path: bridge avatar → PIL composite → comfy kontext → crop ─

function localComposite(avatarPath, outPath) {
  execFileSync('python3', [
    COMPOSITE_HELPER, 'composite',
    '--avatar', avatarPath,
    '--reference', TPOSE_REFERENCE,
    '--out', outPath,
  ], { stdio: ['ignore', 'inherit', 'inherit'] })
}

function localKontext(compositePath, outPath) {
  execFileSync('python3', [
    COMFY_CLIENT, 'kontext',
    '--server', COMFY_URL,
    '--prompt', TPOSE_PROMPT,
    '--image', compositePath,
    '--out', outPath,
    '--seed', String(Math.floor(Math.random() * 2_147_483_647)),
  ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600_000 })
}

async function generateTposeLocal(pubkey, npub) {
  const stamp = Date.now()
  const dir = tmpdir()
  const avatarPath = join(dir, `woid-tpose-${stamp}-avatar.png`)
  const compositePath = join(dir, `woid-tpose-${stamp}-comp.png`)
  const resultPath = join(dir, `woid-tpose-${stamp}-result.png`)
  const cropPath = join(dir, `woid-tpose-${stamp}-tpose.png`)

  await fetchAvatar(pubkey, avatarPath)
  localComposite(avatarPath, compositePath)
  localKontext(compositePath, resultPath)
  // Comfy kontext (like NIM kontext) redraws a single full-canvas figure
  // — it doesn't preserve the side-by-side layout. So we keep the full
  // result rather than cropping the right half.

  const buf = readFileSync(resultPath)
  await writeTposeToBridge(npub, buf)
  return buf.length
}

// ─── Main ───────────────────────────────────────────────────────────

console.log('Loading characters from bridge…')
const all = await listCharacters()
const byPubkey = new Map(all.map((c) => [c.pubkey, c]))

let targets = []
if (allOrphans) {
  for (const c of all) {
    if (nameFilter && !nameFilter.test(c.name || '')) continue
    if (!(await avatarExists(c.pubkey))) continue
    if (!force && await tposeExists(c.pubkey)) continue
    targets.push(c)
  }
  console.log(`  mode: --all-orphans  ·  source: ${source}`)
} else {
  if (!existsSync(manifestPath)) {
    console.error(`\nNo manifest at ${manifestPath}. Run generate-personas.mjs first,`)
    console.error(`or pass --all-orphans to process every character with avatar-but-no-tpose.`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const entry of manifest.characters || []) {
    const c = byPubkey.get(entry.pubkey)
    if (!c) { console.log(`  · ${entry.name}: not on bridge anymore, skipping`); continue }
    if (nameFilter && !nameFilter.test(c.name || '')) continue
    if (!(await avatarExists(c.pubkey))) {
      console.log(`  · ${c.name}: no avatar yet, skipping`); continue
    }
    if (!force && await tposeExists(c.pubkey)) continue
    targets.push(c)
  }
  console.log(`  manifest: ${manifestPath}  ·  ${manifest.characters?.length || 0} entries  ·  source: ${source}`)
}
targets = targets.slice(0, limit)

console.log(`\n${targets.length} characters to process${force ? ' (--force)' : ''}\n`)

let okCount = 0, failedCount = 0
const t0 = Date.now()

for (const c of targets) {
  const start = Date.now()
  console.log(`=== ${c.name}  (${c.pubkey.slice(0, 12)}…) ===`)
  try {
    if (source === 'cloud') {
      await generateTposeCloud(c.pubkey)
      const dt = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`  ✓ tpose via cloud flux-kontext in ${dt}s\n`)
    } else {
      const bytes = await generateTposeLocal(c.pubkey, c.npub)
      const dt = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`  ✓ ${bytes}B via local comfy-kontext in ${dt}s\n`)
    }
    okCount += 1
  } catch (err) {
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  ✗ ${err.message} (${dt}s)\n`)
    failedCount += 1
  }
}

const total = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`Done. ${okCount} ok, ${failedCount} failed. Total ${total}s.`)
process.exit(failedCount > 0 ? 1 : 0)

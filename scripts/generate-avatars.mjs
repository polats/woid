#!/usr/bin/env node
/**
 * STEP 2 of the cast pipeline: avatars.
 *
 * For each cast character (drawn from the manifest written by
 * generate-personas.mjs), generate a portrait either via cloud NIM
 * (default) or local ComfyUI flux-schnell.
 *
 * cloud (default) — cycles through three hosted NIM models on safety
 * block:
 *   1. black-forest-labs/flux.1-schnell  (cfg_scale=0,   steps=4)
 *   2. black-forest-labs/flux.1-dev      (cfg_scale=3.5, steps=28)
 *   3. black-forest-labs/flux.2-klein-4b (cfg_scale=1.0, steps=4)
 *
 * local — calls the comfyui-runpod `client.py schnell` against a
 * locally-running ComfyUI worker at localhost:8191. Same flux.1-
 * schnell model, different (zero) safety filter.
 *
 * Idempotent: characters that already have an avatar on disk are
 * skipped unless --force is passed.
 *
 * Usage:
 *   node scripts/generate-avatars.mjs                       # cloud, from manifest
 *   node scripts/generate-avatars.mjs --source=local        # local Comfy schnell
 *   node scripts/generate-avatars.mjs --force               # regen all
 *   node scripts/generate-avatars.mjs --limit=1             # smoke test
 *   node scripts/generate-avatars.mjs --name='Bronwyn'      # filter
 *   node scripts/generate-avatars.mjs --manifest=path.json  # custom manifest
 *   node scripts/generate-avatars.mjs --all-orphans         # ignore manifest;
 *                                                           # pick up any char
 *                                                           # without an avatar
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const NIM_BASE = 'https://ai.api.nvidia.com/v1/genai'
const COMFY_URL = process.env.COMFY_URL || 'http://localhost:8191'
const COMFY_CLIENT = '/home/paul/projects/google-cloud/gemma-4-self-hosted/comfyui-runpod/client.py'
const COMPOSE_FILE = '/home/paul/projects/woid/agent-sandbox/docker-compose.yml'

// Tiny-image threshold for safety-block detection. NIM's blocked
// frames come back at exactly 6213B (a fixed blank PNG). Real
// outputs are 100KB-300KB.
const SAFETY_BLOCK_MAX_BYTES = 15_000

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
const source = (kv.source || 'cloud').toLowerCase()    // 'cloud' | 'local'
if (!['cloud', 'local'].includes(source)) {
  console.error(`--source must be 'cloud' or 'local' (got ${source})`)
  process.exit(1)
}
const manifestPath = resolve(
  kv.manifest || 'e2e-runs/cast-manifest.json',
)

// ─── NIM key ────────────────────────────────────────────────────────

function loadNimKey() {
  const envFile = '/home/paul/projects/woid/agent-sandbox/.env'
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*NVIDIA_NIM_API_KEY\s*=\s*(.+?)\s*$/)
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  throw new Error('NVIDIA_NIM_API_KEY not found in agent-sandbox/.env')
}
const NIM_KEY = loadNimKey()

// ─── Fallback ladder ────────────────────────────────────────────────

const MODELS = [
  {
    id: 'flux.1-schnell',
    path: 'black-forest-labs/flux.1-schnell',
    body: (prompt, seed) => ({ prompt, cfg_scale: 0, steps: 4, width: 1024, height: 1024, seed }),
  },
  {
    id: 'flux.1-dev',
    path: 'black-forest-labs/flux.1-dev',
    body: (prompt, seed) => ({ prompt, cfg_scale: 3.5, steps: 28, width: 1024, height: 1024, seed }),
  },
  {
    id: 'flux.2-klein-4b',
    path: 'black-forest-labs/flux.2-klein-4b',
    body: (prompt, seed) => ({ prompt, cfg_scale: 1.0, steps: 4, width: 1024, height: 1024, seed }),
  },
]

async function callNim(model, prompt, seed) {
  const r = await fetch(`${NIM_BASE}/${model.path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NIM_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(model.body(prompt, seed)),
    signal: AbortSignal.timeout(180_000),
  })
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 200)
    throw new Error(`HTTP ${r.status}: ${detail}`)
  }
  const j = await r.json()
  const b64 = j.image ?? j.artifacts?.[0]?.base64 ?? j.data?.[0]?.b64_json
  if (!b64) throw new Error('no image bytes in response')
  return Buffer.from(b64, 'base64')
}

async function generateAvatarBytesCloud(prompt) {
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const seed = Math.floor(Math.random() * 2_147_483_647)
      try {
        const buf = await callNim(model, prompt, seed)
        if (buf.length >= SAFETY_BLOCK_MAX_BYTES) {
          return { buf, model: model.id }
        }
        console.log(`      ${model.id}: ${buf.length}B (safety-blocked), retry${attempt < 1 ? '' : ' next model'}`)
      } catch (err) {
        console.log(`      ${model.id}: ${err.message.slice(0, 160)}`)
        break  // HTTP error → move to next model
      }
    }
  }
  throw new Error('all 3 NIM models exhausted')
}

async function generateAvatarBytesLocal(prompt) {
  const outPath = join(tmpdir(), `woid-avatar-${Date.now()}.png`)
  execFileSync('python3', [
    COMFY_CLIENT, 'schnell',
    '--server', COMFY_URL,
    '--prompt', prompt,
    '--out', outPath,
    '--seed', String(Math.floor(Math.random() * 2_147_483_647)),
  ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600_000 })
  if (!existsSync(outPath)) throw new Error('local comfy produced no output')
  const buf = readFileSync(outPath)
  return { buf, model: 'comfy-local/flux.1-schnell' }
}

async function generateAvatarBytes(prompt) {
  if (source === 'local') return generateAvatarBytesLocal(prompt)
  return generateAvatarBytesCloud(prompt)
}

// ─── Bridge: list chars + write avatar ──────────────────────────────

async function listCharacters() {
  const r = await fetch(`${BRIDGE}/characters`)
  if (!r.ok) throw new Error(`list characters HTTP ${r.status}`)
  return (await r.json()).characters
}

async function avatarOnDisk(pubkey) {
  // HEAD is supported and 404s when missing.
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/avatar`, { method: 'HEAD' })
  return r.ok
}

function writeAvatarToBridge(npub, bytes) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [
      'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'pi-bridge',
      'sh', '-c',
      `mkdir -p /workspace/characters/${npub} && cat > /workspace/characters/${npub}/avatar.png`,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })
    proc.on('error', reject)
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`docker exec exit ${code}`)))
    proc.stdin.end(bytes)
  })
}

async function patchAvatarUrl(pubkey) {
  // The bridge's generateAvatar route writes this URL to the manifest
  // so the frontend's character cards refresh. Mirror that shape so
  // the agent sandbox card picks up the new image without a hard
  // reload.
  const avatarUrl = `${BRIDGE}/characters/${pubkey}/avatar?t=${Date.now()}`
  const r = await fetch(`${BRIDGE}/characters/${pubkey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarUrl }),
  })
  if (!r.ok) throw new Error(`patch avatarUrl HTTP ${r.status}`)
}

// ─── Main ───────────────────────────────────────────────────────────

console.log('Loading characters from bridge…')
const all = await listCharacters()
const byPubkey = new Map(all.map((c) => [c.pubkey, c]))

let targets = []
if (allOrphans) {
  // Legacy mode — process any character with `about` but no avatar.
  // Sweeps in pre-existing characters too; use sparingly.
  for (const c of all) {
    if (!c.about) continue
    if (nameFilter && !nameFilter.test(c.name || '')) continue
    if (!force && await avatarOnDisk(c.pubkey)) continue
    targets.push(c)
  }
  console.log(`  mode: --all-orphans (no manifest)  ·  source: ${source}`)
} else {
  // Default — read the manifest written by generate-personas.mjs so
  // we only touch this batch.
  if (!existsSync(manifestPath)) {
    console.error(`\nNo manifest at ${manifestPath}. Run generate-personas.mjs first,`)
    console.error(`or pass --all-orphans to process every character without an avatar.`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const entry of manifest.characters || []) {
    const c = byPubkey.get(entry.pubkey)
    if (!c) {
      console.log(`  · ${entry.name}: not on bridge anymore, skipping`)
      continue
    }
    if (nameFilter && !nameFilter.test(c.name || '')) continue
    if (!force && await avatarOnDisk(c.pubkey)) continue
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
  const prompt = [
    `Stylized portrait illustration of: ${c.name} — ${c.about}.`,
    'Use the description as thematic inspiration for mood, role, and atmosphere rather than copying specific nouns into the image.',
    'Composition: square 1:1, centered, strong silhouette, clear subject, clean negative space around the figure.',
    'No text, no watermark, no signatures, no UI chrome, no logos.',
  ].join(' ')
  console.log(`=== ${c.name}  (${c.pubkey.slice(0, 12)}…) ===`)
  try {
    const { buf, model } = await generateAvatarBytes(prompt)
    await writeAvatarToBridge(c.npub, buf)
    await patchAvatarUrl(c.pubkey)
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  ✓ ${buf.length}B via ${model} in ${dt}s\n`)
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

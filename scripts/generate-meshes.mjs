#!/usr/bin/env node
/**
 * STEP 4 of the cast pipeline: 3D meshes (TRELLIS).
 *
 * cloud (default) — delegates to bridge `/generate-model/stream` which
 * routes to the self-hosted TRELLIS Cloud Run service. Serialization
 * and warm probing happen inside the bridge.
 *
 * local — runs comfyui-runpod `client.py trellis` against the local
 * ComfyUI worker (mesh-only; flip to trellis-tex if you want textures).
 * Writes model.glb back to the bridge volume.
 *
 * Notes:
 *  · NIM's hosted trellis (ai.api.nvidia.com/v1/genai/microsoft/trellis)
 *    is a *preview API* that only accepts 4 predefined example images
 *    (example_id 0-3). It cannot ingest our tposes, so cloud goes
 *    through the bridge's Cloud Run instance instead.
 *  · Idempotent: chars with model.glb on disk are skipped unless
 *    --force is passed.
 *
 * Usage:
 *   node scripts/generate-meshes.mjs                       # cloud, from manifest
 *   node scripts/generate-meshes.mjs --source=local        # local Comfy trellis
 *   node scripts/generate-meshes.mjs --local-texture       # use trellis-tex
 *   node scripts/generate-meshes.mjs --limit=1 --name=Zora # smoke
 *   node scripts/generate-meshes.mjs --force               # regen
 *   node scripts/generate-meshes.mjs --all-orphans         # tpose-but-no-mesh
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const COMFY_URL = process.env.COMFY_URL || 'http://localhost:8191'
const COMFY_CLIENT = '/home/paul/projects/google-cloud/gemma-4-self-hosted/comfyui-runpod/client.py'
const COMPOSE_FILE = '/home/paul/projects/woid/agent-sandbox/docker-compose.yml'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')))
const kv = Object.fromEntries(
  args.filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)] }),
)
const force = flags.has('--force')
const allOrphans = flags.has('--all-orphans')
const localTexture = flags.has('--local-texture')
const lowpoly = flags.has('--lowpoly')
const limit = kv.limit ? parseInt(kv.limit, 10) : Infinity
const nameFilter = kv.name ? new RegExp(kv.name, 'i') : null
const source = (kv.source || 'cloud').toLowerCase()
if (!['cloud', 'local'].includes(source)) {
  console.error(`--source must be 'cloud' or 'local' (got ${source})`)
  process.exit(1)
}
// Backend selector — only relevant for --source=cloud. Bridge supports
// trellis (default, image-to-3d via Cloud Run TRELLIS) and hunyuan3d.
const backend = (kv.backend || 'trellis').toLowerCase()
if (!['trellis', 'hunyuan3d'].includes(backend)) {
  console.error(`--backend must be 'trellis' or 'hunyuan3d' (got ${backend})`)
  process.exit(1)
}
const manifestPath = resolve(kv.manifest || 'e2e-runs/cast-manifest.json')

// ─── Bridge helpers ─────────────────────────────────────────────────

async function listCharacters() {
  const r = await fetch(`${BRIDGE}/characters`)
  if (!r.ok) throw new Error(`list characters HTTP ${r.status}`)
  return (await r.json()).characters
}

async function tposeExists(pubkey) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/tpose`, { method: 'HEAD' })
  return r.ok
}

async function modelExists(pubkey) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/model`, { method: 'HEAD' })
  return r.ok
}

async function fetchTpose(pubkey, outPath) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/tpose`)
  if (!r.ok) throw new Error(`fetch tpose HTTP ${r.status}`)
  writeFileSync(outPath, Buffer.from(await r.arrayBuffer()))
}

function writeModelToBridge(npub, bytes) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [
      'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'pi-bridge',
      'sh', '-c',
      `mkdir -p /workspace/characters/${npub} && cat > /workspace/characters/${npub}/model.glb`,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })
    proc.on('error', reject)
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`docker exec exit ${code}`)))
    proc.stdin.end(bytes)
  })
}

// ─── Cloud path: SSE drive of bridge endpoint ───────────────────────

async function generateMeshCloud(pubkey) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/generate-model/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend }),
    signal: AbortSignal.timeout(900_000),
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
        return parsed
      }
    }
  }
  throw new Error('stream ended without done event')
}

// ─── Local path: bridge tpose → comfy trellis → bridge model.glb ─────

function localTrellis(tposePath, outPath) {
  const sub = `${localTexture ? 'trellis-tex' : 'trellis'}${lowpoly ? '-lowpoly' : ''}`
  execFileSync('python3', [
    COMFY_CLIENT, sub,
    '--server', COMFY_URL,
    '--image', tposePath,
    '--out', outPath,
    '--seed', String(Math.floor(Math.random() * 2_147_483_647)),
  ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 900_000 })
}

async function generateMeshLocal(pubkey, npub) {
  const stamp = Date.now()
  const dir = tmpdir()
  const tposePath = join(dir, `woid-mesh-${stamp}-tpose.png`)
  const meshPath = join(dir, `woid-mesh-${stamp}-model.glb`)

  await fetchTpose(pubkey, tposePath)
  localTrellis(tposePath, meshPath)

  const buf = readFileSync(meshPath)
  await writeModelToBridge(npub, buf)
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
    if (!(await tposeExists(c.pubkey))) continue
    if (!force && await modelExists(c.pubkey)) continue
    targets.push(c)
  }
  console.log(`  mode: --all-orphans  ·  source: ${source}${source === 'local' && localTexture ? ' (textured)' : ''}`)
} else {
  if (!existsSync(manifestPath)) {
    console.error(`\nNo manifest at ${manifestPath}. Run generate-personas.mjs first,`)
    console.error(`or pass --all-orphans to process every character with tpose-but-no-mesh.`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const entry of manifest.characters || []) {
    const c = byPubkey.get(entry.pubkey)
    if (!c) { console.log(`  · ${entry.name}: not on bridge anymore, skipping`); continue }
    if (nameFilter && !nameFilter.test(c.name || '')) continue
    if (!(await tposeExists(c.pubkey))) {
      console.log(`  · ${c.name}: no tpose yet, skipping`); continue
    }
    if (!force && await modelExists(c.pubkey)) continue
    targets.push(c)
  }
  console.log(`  manifest: ${manifestPath}  ·  ${manifest.characters?.length || 0} entries  ·  source: ${source}${source === 'local' && localTexture ? ' (textured)' : ''}`)
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
      const r = await generateMeshCloud(c.pubkey)
      const dt = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`  ✓ ${r.bytes}B via cloud ${backend} in ${dt}s\n`)
    } else {
      const bytes = await generateMeshLocal(c.pubkey, c.npub)
      const dt = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`  ✓ ${bytes}B via local comfy-trellis${localTexture ? '-tex' : ''} in ${dt}s\n`)
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

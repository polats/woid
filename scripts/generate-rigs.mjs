#!/usr/bin/env node
/**
 * STEP 5 of the cast pipeline: rig + kimodo finalize.
 *
 * Drives the bridge's /generate-rig/stream endpoint per character
 * serially. There is no local path — UniRig and kimodo-tools both run
 * as Cloud Run services behind the bridge.
 *
 * The bridge chain is:
 *   1. UniRig service → rig.glb
 *   2. kimodo-tools /rig-finalize → bone mapping + palms-down bake +
 *      import to the kimodo registry
 *
 * Idempotent: chars with kimodo.json on disk are skipped unless
 * --force is passed (which the bridge also honors for cross-backend
 * regen).
 *
 * Usage:
 *   node scripts/generate-rigs.mjs                       # from manifest
 *   node scripts/generate-rigs.mjs --limit=1 --name=Zora # smoke
 *   node scripts/generate-rigs.mjs --force               # re-rig
 *   node scripts/generate-rigs.mjs --all-orphans         # mesh-but-no-rig
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'

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
const manifestPath = resolve(kv.manifest || 'e2e-runs/cast-manifest.json')

async function listCharacters() {
  const r = await fetch(`${BRIDGE}/characters`)
  if (!r.ok) throw new Error(`list characters HTTP ${r.status}`)
  return (await r.json()).characters
}

async function modelExists(pubkey) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/model`, { method: 'HEAD' })
  return r.ok
}

async function rigStatus(pubkey) {
  // kimodo.json marker is the canonical "rigged" signal. Bridge exposes
  // /characters/:pubkey returning the marker contents when present.
  const r = await fetch(`${BRIDGE}/characters/${pubkey}`)
  if (!r.ok) return null
  const c = await r.json()
  return c.kimodo || c.rig || null
}

async function generateRig(pubkey) {
  const r = await fetch(`${BRIDGE}/characters/${pubkey}/generate-rig/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend: 'trellis', force }),
    signal: AbortSignal.timeout(1_800_000),
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

// ─── Main ───────────────────────────────────────────────────────────

console.log('Loading characters from bridge…')
const all = await listCharacters()
const byPubkey = new Map(all.map((c) => [c.pubkey, c]))

let targets = []
if (allOrphans) {
  for (const c of all) {
    if (nameFilter && !nameFilter.test(c.name || '')) continue
    if (!(await modelExists(c.pubkey))) continue
    if (!force && (await rigStatus(c.pubkey))) continue
    targets.push(c)
  }
  console.log(`  mode: --all-orphans`)
} else {
  if (!existsSync(manifestPath)) {
    console.error(`\nNo manifest at ${manifestPath}.`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const entry of manifest.characters || []) {
    const c = byPubkey.get(entry.pubkey)
    if (!c) { console.log(`  · ${entry.name}: not on bridge anymore, skipping`); continue }
    if (nameFilter && !nameFilter.test(c.name || '')) continue
    if (!(await modelExists(c.pubkey))) {
      console.log(`  · ${c.name}: no model yet, skipping`); continue
    }
    if (!force && (await rigStatus(c.pubkey))) continue
    targets.push(c)
  }
  console.log(`  manifest: ${manifestPath}  ·  ${manifest.characters?.length || 0} entries`)
}
targets = targets.slice(0, limit)

console.log(`\n${targets.length} characters to process${force ? ' (--force)' : ''}\n`)

let okCount = 0, failedCount = 0
const t0 = Date.now()

for (const c of targets) {
  const start = Date.now()
  console.log(`=== ${c.name}  (${c.pubkey.slice(0, 12)}…) ===`)
  try {
    await generateRig(c.pubkey)
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  ✓ rigged + imported in ${dt}s\n`)
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

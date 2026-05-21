#!/usr/bin/env node
/**
 * One-shot helper: mint a small set of NPC characters with
 * pre-baked avatar PNGs (no AI generation needed), then write a
 * manifest the existing tpose / mesh / rig scripts can drive
 * against.
 *
 * For each entry:
 *   1. POST /characters with kind:'npc', name, npc_role.
 *   2. PATCH /characters/:pubkey with { about, specialty,
 *      personality, added: true }.
 *   3. Pipe the PNG into the bridge volume at
 *      /workspace/characters/<npub>/avatar.png so /characters/:pk
 *      /avatar serves it.
 *   4. Append to e2e-runs/npc-manifest.json.
 *
 * After this, run:
 *   node scripts/generate-tposes.mjs  --source=cloud --manifest=e2e-runs/npc-manifest.json
 *   node scripts/generate-meshes.mjs  --source=local --local-texture --lowpoly --manifest=e2e-runs/npc-manifest.json
 *   node scripts/generate-rigs.mjs    --manifest=e2e-runs/npc-manifest.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const COMPOSE_FILE = '/home/paul/projects/woid/agent-sandbox/docker-compose.yml'
const MANIFEST = resolve('e2e-runs/npc-manifest.json')

const NPCS = [
  {
    imagePath: '/home/paul/projects/woid/public/mika.png',
    name: 'Mika',
    npc_role: 'hospitality',
    specialty: 'Hospitality',
    personality: 'Warm, professional',
    about: 'Mid 30s hospitality lead. Cream-coloured tailored blazer over a pale blue blouse, knee-length skirt, dark bob with side-swept bangs, holding a small porcelain cup. Carries a tan leather portfolio. Warm and unflappable; always seems to be the most awake person in the building.',
  },
  {
    imagePath: '/home/paul/projects/woid/public/nina.png',
    name: 'Nina',
    npc_role: 'records-clerk',
    specialty: 'Records Clerk',
    personality: 'Knowing, sly',
    about: 'Late 30s records clerk. Tan tailored suit over a pale blue blouse, blonde hair in a neat updo, gold hoop earrings, red lipstick, finger raised to her chin in mid-thought. Always seems to know more than she lets on; speaks softly when she does.',
  },
]

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${url} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
async function patchJson(url, body) {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`PATCH ${url} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

function writeAvatarToBridge(npub, bytes) {
  return new Promise((res, rej) => {
    const proc = spawn('docker', [
      'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'pi-bridge',
      'sh', '-c',
      `mkdir -p /workspace/characters/${npub} && cat > /workspace/characters/${npub}/avatar.png`,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })
    proc.on('error', rej)
    proc.on('exit', (c) => c === 0 ? res() : rej(new Error(`docker exec exit ${c}`)))
    proc.stdin.end(bytes)
  })
}

// ─── Main ───────────────────────────────────────────────────────────

const minted = []
for (const npc of NPCS) {
  console.log(`=== ${npc.name} (${npc.npc_role}) ===`)
  // 1. mint
  const created = await postJson(`${BRIDGE}/characters`, {
    name: npc.name,
    kind: 'npc',
    npc_role: npc.npc_role,
  })
  console.log(`  minted  ${created.pubkey.slice(0, 12)}…  npub=${created.npub.slice(0, 16)}…`)

  // 2. patch profile fields + flip `added`
  await patchJson(`${BRIDGE}/characters/${created.pubkey}`, {
    about: npc.about,
    specialty: npc.specialty,
    personality: npc.personality,
    added: true,
  })
  console.log(`  patched about + specialty + personality + added:true`)

  // 3. upload pre-baked avatar
  const png = readFileSync(npc.imagePath)
  await writeAvatarToBridge(created.npub, png)
  // Force the bridge to register the avatarUrl so the frontend
  // picks it up (PATCH won't accept avatarUrl directly; rely on
  // the GET /characters/:pubkey/avatar route serving from disk).
  console.log(`  uploaded ${(png.length / 1024).toFixed(0)} KB avatar.png`)

  minted.push({
    name: npc.name,
    pubkey: created.pubkey,
    npub: created.npub,
    gender: null,
  })
}

mkdirSync(dirname(MANIFEST), { recursive: true })
writeFileSync(MANIFEST, JSON.stringify({
  createdAt: new Date().toISOString(),
  source: 'manual-from-images',
  characters: minted,
}, null, 2))
console.log(`\nWrote ${MANIFEST} with ${minted.length} entries.`)
console.log('Next:')
console.log('  node scripts/generate-tposes.mjs --source=cloud --manifest=e2e-runs/npc-manifest.json')
console.log('  node scripts/generate-meshes.mjs --source=local --local-texture --lowpoly --manifest=e2e-runs/npc-manifest.json')
console.log('  node scripts/generate-rigs.mjs --manifest=e2e-runs/npc-manifest.json')

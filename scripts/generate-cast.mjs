#!/usr/bin/env node
/**
 * Generate the trailer / demo cast using the SAME bridge endpoints the
 * AgentProfile UI hits:
 *
 *   1. POST /characters            → mint (with our chosen name)
 *   2. /generate-profile/stream    → LLM persona + curated FLUX avatar
 *   3. /generate-tpose/stream      → FLUX.1 Kontext T-pose
 *   4. /generate-model/stream      → TRELLIS image-to-3d mesh
 *   5. /generate-rig/stream        → UniRig + palms-down + kimodo-import
 *   6. PATCH /characters/:pubkey   → flag `added: true`
 *
 * This produces the same kind of persona + avatar quality the
 * frontend produces (which is what the user gets when they click
 * Regenerate persona in AgentProfile), unlike the older
 * `generate_character.py --seed-name` path which fed our raw bio
 * straight to FLUX without the LLM's woid-style scaffolding pass.
 *
 * Idempotent on the SEED LEVEL: we don't re-mint chars from a prior
 * run automatically (mints always produce a fresh pubkey) — re-running
 * makes more characters. Add `--clean` to first delete any character
 * whose name matches one in the cast.
 *
 * Usage:
 *   node scripts/generate-cast.mjs                 # mint + full pipeline for all 12
 *   node scripts/generate-cast.mjs --clean         # delete existing by name first
 *   node scripts/generate-cast.mjs "Pearl|Esme"    # regex filter the cast list
 */
const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'

const CAST = [
  ['Wayne Boggs',       'male',   'A weary 52-year-old data sorter at the Company. Balding with a horseshoe of grey-brown hair, glasses on a beaded cord. Khaki short-sleeve shirt, thin maroon tie. Permanent worried squint.'],
  ['Roland Kaye',       'male',   'A 38-year-old wiry archivist. Dark untidy hair, full beard, oval wire-rim glasses. Tobacco-stained brown cardigan over a beige polo, faded jeans. Always carrying a clipboard.'],
  ['Hiroto Lin',        'male',   'A 29-year-old slim severance-style office worker, East Asian. Jet black hair in a side part, smooth-shaven. White button-down shirt, slim grey tie, dark trousers. Quietly intense.'],
  ['Mort Chevallier',   'male',   'A heavyset 55-year-old French cafeteria manager. Full grey moustache, ruddy face, balding. White short-sleeve shirt with rolled sleeves, brown apron, dark trousers. Easy smile, tired eyes.'],
  ['Bertram Hess',      'male',   'A 68-year-old elderly executive, German, slight stoop. Three-piece dark wool suit with a navy bow tie, thinning white hair combed back, half-moon spectacles. Dignified bearing.'],
  ['Otto Spire',        'male',   'A 45-year-old Black security officer with a meticulous handlebar mustache. Beige short-sleeve uniform with a black tie and brass badge, close-cropped hair, broad athletic shoulders.'],
  ['Pearl Greaves',     'female', 'A 49-year-old reception desk supervisor. Mint-green wool twin-set with pearl buttons, blonde hair in a tidy 1980s bouffant, reading glasses on her head. Warm but no-nonsense.'],
  ['Esme Plok',         'female', 'A 33-year-old bohemian tape librarian. Frizzy auburn hair half tied back, freckles, round tortoiseshell glasses. Long olive corduroy skirt, mustard cardigan over a cream blouse, clogs.'],
  ['Lillian Hwang',     'female', 'A 41-year-old East Asian mailroom supervisor. Sharp chin-length black bob with a side part. Navy blazer over a white blouse, mid-length grey pencil skirt, low heels. Watchful eyes.'],
  ['Mavis Olcoot',      'female', 'A 57-year-old tall senior compliance officer. Severe slate-grey skirt suit, hair in a tight grey bun, rimless rectangular glasses on a chain. A small enamel company-seal pin. Stern.'],
  ['Theodora Trash',    'female', 'A 62-year-old senior cleaning supervisor, Black, sturdy build. Mauve smock over a charcoal long-sleeve shirt, hair in a low grey ponytail, hoop earrings. Sensible white sneakers.'],
  ['Kit Vanderlaan',    'female', 'A 28-year-old athletic Dutch security analyst. Short blonde undercut, navy short-sleeve uniform with shoulder patches, utility belt. Sleeveless under-shirt visible at the collar.'],
]

// ─── Args ────────────────────────────────────────────────────────────

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const filter = positional[0] ? new RegExp(positional[0]) : null
const wanted = filter ? CAST.filter((c) => filter.test(c[0])) : CAST

// ─── SSE consumer ────────────────────────────────────────────────────

async function consumeSse(res, label, onStage = null) {
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = '', done = null, error = null
  let lastStage = null
  while (true) {
    const { value, done: end } = await reader.read()
    if (end) break
    buf += decoder.decode(value, { stream: true })
    const events = buf.split(/\n\n/); buf = events.pop() ?? ''
    for (const ev of events) {
      const lines = ev.split('\n')
      let type = 'message'; const data = []
      for (const l of lines) {
        if (l.startsWith('event:')) type = l.slice(6).trim()
        else if (l.startsWith('data:')) data.push(l.slice(5).trimStart())
      }
      if (!data.length) continue
      let parsed; try { parsed = JSON.parse(data.join('\n')) } catch { continue }
      if (type === 'done') done = parsed
      else if (type === 'error') error = parsed.error || 'stream error'
      else if (type === 'stage' && parsed.stage && parsed.stage !== lastStage) {
        lastStage = parsed.stage
        if (onStage) onStage(parsed)
      }
    }
  }
  if (error) throw new Error(error)
  return done
}

const stagePrinter = (label) => (p) => {
  process.stdout.write(`    ${label}/${p.stage}${p.message ? ': ' + p.message : ''}\n`)
}

// ─── Per-character pipeline ─────────────────────────────────────────

async function runOne(name, gender, brief) {
  // 1) Mint with our chosen name. POST /characters only accepts
  //    `name` / `kind` / npc fields — `about` is intentionally NOT in
  //    the create body (the previous generate_character.py --seed-name
  //    path tried to pass `about` here and silently lost it, which is
  //    why personas came out empty).
  const mintRes = await fetch(`${BRIDGE}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, kind: 'player' }),
  })
  if (!mintRes.ok) throw new Error(`mint failed: ${mintRes.status} ${await mintRes.text()}`)
  const { pubkey } = await mintRes.json()
  console.log(`  pubkey ${pubkey.slice(0, 12)}…`)

  // 2) PATCH the hand-written bio onto the character. This is what the
  //    avatar / tpose / model stages will read downstream. Curated by
  //    hand so we get the cast personalities we want, not whatever the
  //    LLM hallucinates from a seed.
  const aboutRes = await fetch(`${BRIDGE}/characters/${pubkey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ about: brief }),
  })
  if (!aboutRes.ok) throw new Error(`set about failed: ${aboutRes.status}`)

  // 3) Avatar. First try with our hand-written bio (PATCH'd above) and
  //    the standalone /generate-avatar endpoint — same path the
  //    AgentProfile UI's "Regenerate avatar" button uses. If NIM safety-
  //    filter blocks our hand-written bio's FLUX prompt (returns 500
  //    after the bridge's internal 3-retry), regenerate the persona via
  //    /generate-profile/stream which both rerolls the `about` text via
  //    LLM AND retries the avatar in one shot. Up to 3 persona rerolls
  //    before we give up on this character.
  console.log('  [avatar — hand-written bio]')
  let avatarOk = false
  let ar = await fetch(`${BRIDGE}/characters/${pubkey}/generate-avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (ar.ok) {
    avatarOk = true
  } else {
    const detail = (await ar.text()).slice(0, 200)
    console.log(`    hand-written bio's avatar failed (${ar.status}): ${detail}`)
    console.log('    falling back to LLM-generated personas')
    for (let attempt = 1; attempt <= 3 && !avatarOk; attempt++) {
      console.log(`    persona reroll ${attempt}/3`)
      await consumeSse(
        await fetch(`${BRIDGE}/characters/${pubkey}/generate-profile/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            seed: `${gender} character. ${brief}`,
            overwriteName: false,
          }),
        }),
        `persona-${attempt}`, stagePrinter(`persona-${attempt}`),
      )
      // The stream's avatar step is inline — fetch the char to check.
      const cr = await fetch(`${BRIDGE}/characters/${pubkey}`)
      const c = await cr.json()
      if (c.avatarUrl) { avatarOk = true; break }
    }
  }
  if (!avatarOk) throw new Error('avatar generation kept getting safety-blocked across 3 persona rerolls')

  // 3) T-pose — FLUX.1 Kontext reads the avatar.jpeg and produces
  //    tpose.png. Same endpoint AgentProfile uses.
  console.log('  [tpose]')
  await consumeSse(
    await fetch(`${BRIDGE}/characters/${pubkey}/generate-tpose/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    'tpose', stagePrinter('tpose'),
  )

  // 4) Mesh — TRELLIS reads tpose.png, produces model.glb.
  console.log('  [model]')
  await consumeSse(
    await fetch(`${BRIDGE}/characters/${pubkey}/generate-model/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'trellis' }),
    }),
    'model', stagePrinter('model'),
  )

  // 5) Rig + palms-fix + kimodo-import. The bridge's /generate-rig/stream
  //    chains all three: UniRig → kimodo-tools mapping/palms/import.
  console.log('  [rig]')
  await consumeSse(
    await fetch(`${BRIDGE}/characters/${pubkey}/generate-rig/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'trellis', force: true }),
    }),
    'rig', stagePrinter('rig'),
  )

  // 6) Flag `added: true` so demoMode + the curated pool surface this
  //    character.
  const tagRes = await fetch(`${BRIDGE}/characters/${pubkey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ added: true }),
  })
  if (!tagRes.ok) throw new Error(`tag added failed: ${tagRes.status}`)
  console.log('  ✓ added')

  return pubkey
}

// ─── --clean: remove any existing characters with the same names ────

async function cleanByName() {
  const r = await fetch(`${BRIDGE}/characters`)
  const { characters } = await r.json()
  const targetNames = new Set(wanted.map(([n]) => n))
  const matches = characters.filter((c) => targetNames.has(c.name))
  if (!matches.length) return
  console.log(`\n--clean: deleting ${matches.length} pre-existing character(s):`)
  for (const c of matches) {
    const dr = await fetch(`${BRIDGE}/characters/${c.pubkey}`, { method: 'DELETE' })
    console.log(`  ${c.name.padEnd(22)} ${c.pubkey.slice(0,12)}…  ${dr.ok ? 'ok' : 'FAIL'}`)
  }
}

// ─── Main loop ──────────────────────────────────────────────────────

if (flags.has('--clean')) await cleanByName()

console.log(`\nGenerating ${wanted.length} character(s):`)
let ok = 0, failed = 0
const t0 = Date.now()
for (const [name, gender, brief] of wanted) {
  console.log(`\n=== ${name} (${gender}) ===`)
  const start = Date.now()
  try {
    await runOne(name, gender, brief)
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  ✓ DONE in ${dt}s`)
    ok += 1
  } catch (err) {
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  ✗ FAILED in ${dt}s: ${err.message}`)
    failed += 1
  }
}

const total = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\nDone. ${ok} ok, ${failed} failed. Total ${total}s.`)
process.exit(failed > 0 ? 1 : 0)

#!/usr/bin/env node
/**
 * Generate 30 room variations with distinct palette families. Drives
 * the bridge's /rooms/:id/initial endpoint once per prompt — that's
 * the LLM pass that yields metadata + palette + proposed_props + the
 * deterministic placeFromZones layout. We pass `skipConcept: true` so
 * no FLUX image is rendered (cheap), and we never trigger per-prop
 * FLUX / TRELLIS — the rooms exist for their colour identity.
 *
 * After each room generates, its status flips to 'added' so the
 * /v1/room-layouts inventory surfaces it for the shelter build menu
 * and demoMode.populateDemo cycles through it.
 *
 * Usage: node scripts/generate-room-variations.mjs [tag-filter]
 *   tag-filter (optional): regex of ids to limit the run, e.g. "lab|booth".
 *
 * Re-runs are idempotent: each room id is stable, so a second pass
 * overwrites the layout in place.
 */
const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
// Default to qwen3-next-80b — fast (~30s/room), JSON-reliable, and
// alive (kimi-k2-instruct, the previous default, was sunset 2026-05-12).
const PROVIDER = process.env.LLM_PROVIDER || 'nim-qwen3-next-80b'

// Curated prompts. Each suggests a distinct palette family — the LLM
// reads the colour hints and picks five matching hex values for the
// room's palette field. Severance/Stanley Parable/Backrooms/Digital
// Circus anchor is in the system prompt; these just supply the
// per-room mood.
const ROOMS = [
  {
    id: 'telex-hall',
    prompt:
      'A long telex hall in a corporate basement, three telex machines printing paper tape, recessed fluorescent panels overhead, scuffed grey linoleum. Cold institutional pale grey-blue walls, charcoal trim.',
  },
  {
    id: 'archives-annex',
    prompt:
      'An archives annex lined with olive-green steel filing cabinets, drop-tile ceiling with humming fluorescents, worn beige carpet. Deep olive walls, oxide-red cabinet handles.',
  },
  {
    id: 'stenographers-pool',
    prompt:
      'A stenographers pool of two staggered rows of typewriter desks, a single wall clock, tobacco-stained ceiling. Mustard yellow walls, oak desk surfaces, brown carpet.',
  },
  {
    id: 'personnel-records',
    prompt:
      'A personnel records office. Manila folders stacked on long counters, a deep wood filing chest, a brass desk lamp. Cream walls with oxblood chair-rail trim.',
  },
  {
    id: 'mail-sorting',
    prompt:
      'A mail sorting center with pneumatic tube terminals along the back wall and sorting cubbies for each department. Dusty rose walls, mauve carpet, oak counters.',
  },
  {
    id: 'janitorial-stockroom',
    prompt:
      'A janitorial stockroom — mop buckets in the corner, wire shelves of cleaning bottles, a single humming fluorescent. Chartreuse-tinged walls, charcoal concrete floor.',
  },
  {
    id: 'coffee-galley',
    prompt:
      'A 1970s coffee galley. Counter-top drip coffee pots on a hot plate, a small refrigerator, harvest gold floor tile. Avocado green backsplash, brown laminate counters.',
  },
  {
    id: 'vending-bay',
    prompt:
      'A vending bay — five snack and beverage vending machines lined along the back wall under fluorescent panels. Mint green walls, mauve-glow vending fronts, beige floor.',
  },
  {
    id: 'smoking-lounge',
    prompt:
      'A smoking lounge with three vinyl wing chairs around a ceramic ashtray on a wooden pedestal, smoke-stained ceiling. Ochre walls, dark walnut trim, brown carpet.',
  },
  {
    id: 'photocopy-room',
    prompt:
      'A photocopy room — one large beige photocopier centered against the back wall, a paper cutter on a side table, reams of paper stacked nearby. Beige walls with wine-red trim.',
  },
  {
    id: 'server-closet',
    prompt:
      'A server closet — floor-standing beige minicomputers with blinking LEDs, thick cable bundles, an anti-static floor. Cobalt blue cabinet doors, black floor tiles.',
  },
  {
    id: 'maintenance-office',
    prompt:
      'A maintenance office. A workbench with hand tools mounted on pegboard, parts bins along one wall, a single overhead fluorescent. Safety-yellow walls, concrete-grey floor.',
  },
  {
    id: 'health-wellness',
    prompt:
      'A health and wellness suite. Three exercise mats stacked in a corner, a motivational poster on the back wall, soft fluorescent lighting. Pale lilac walls, dusty rose accents.',
  },
  {
    id: 'lactation-room',
    prompt:
      'A lactation room. A single soft armchair, a side table with tissues, a framed floral print on the back wall. Hospital-grade soft lighting. Cream walls, sage green trim.',
  },
  {
    id: 'compliance-office',
    prompt:
      'A compliance office. Two leather executive chairs facing a mahogany desk, a brass desk lamp, framed corporate ethics certificate. Hunter green walls, mahogany wainscoting.',
  },
  {
    id: 'auditorium-storage',
    prompt:
      'An auditorium storage room. Stacked metal folding chairs, folded round tables on rolling racks, a dim caged work light. Putty-coloured walls, weathered oak floor.',
  },
  {
    id: 'cafeteria-service-line',
    prompt:
      'A cafeteria service line. Steam-table buffet against the back wall, plastic-tray racks at one end, hanging menu board overhead. Terracotta tile floor, wheat-coloured walls.',
  },
  {
    id: 'directors-antechamber',
    prompt:
      'A directors antechamber. Two leather wing chairs flanking a sober end table, a framed corporate seal on the back wall, brass floor lamp. Burgundy walls, dark walnut trim.',
  },
  {
    id: 'calibration-lab',
    prompt:
      'A calibration lab. Calibration rigs with dials and gauges on a stainless-steel workbench, a single oscilloscope. Icy blue walls, brushed aluminum panels, white floor.',
  },
  {
    id: 'drafting-bay',
    prompt:
      'A drafting bay. Two drafting tables tilted up, drafting stools beside them, blueprints rolled in a corner bin. Pearl grey walls, teal trim, oak floor.',
  },
  {
    id: 'acoustic-testing',
    prompt:
      'An acoustic testing room. Egg-crate foam covering the back wall, a decibel meter on a stand, a single mic on a boom. Foam-grey walls, lime-green meter accent.',
  },
  {
    id: 'pneumatic-hub',
    prompt:
      'A pneumatic mail hub — twelve brass tubes converging at a dispatcher desk, a wooden chair, racks of message canisters. Tobacco-coloured walls, brass fittings.',
  },
  {
    id: 'decontamination-vestibule',
    prompt:
      'A decontamination vestibule. Emergency shower with chain pull, an eye-wash station, a chemical-shower curtain. Jade tile walls, chrome fixtures, white floor.',
  },
  {
    id: 'lost-and-found',
    prompt:
      'A lost-and-found office. Wire shelves on the back wall holding labeled bins, a drawer of single gloves, a coat rack. Dust-beige walls, sand-coloured concrete floor.',
  },
  {
    id: 'surveillance-booth',
    prompt:
      'A surveillance booth. A wall of small CRT monitors, a microphone switchboard, a single padded swivel chair. Black walls with amber phosphor glow from the screens.',
  },
  {
    id: 'tape-library',
    prompt:
      'A tape library. Floor-to-ceiling shelves of reel-to-reel tape canisters, a single tape playback machine on a side desk. Eggplant-purple walls, silver-grey shelving.',
  },
  {
    id: 'microfilm-reader-room',
    prompt:
      'A microfilm reader room. Three microfilm readers on individual desks, a card catalog cabinet, a wall-mounted index. Chartreuse walls, carbon-grey floor.',
  },
  {
    id: 'plant-room',
    prompt:
      'A plant room. A boiler with ductwork rising overhead, caged work lights, painted machinery. Rust-coloured walls, sage-painted equipment, concrete floor.',
  },
  {
    id: 'coatroom',
    prompt:
      'A staff coatroom. Long row of oak coat hooks lining the back wall, an umbrella stand, a small framed mirror. Dark teal walls, oak hooks and trim.',
  },
  {
    id: 'whiteboard-room',
    prompt:
      'A whiteboard room. Wall-to-wall whiteboards on three walls, a marker tray below each, a single wheeled chair. Cream walls behind the whiteboards, ruby red marker accents.',
  },
]

// ─── SSE consumer ───────────────────────────────────────────────────

async function consumeSse(res) {
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = '', done = null, error = null
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
    }
  }
  if (error) throw new Error(error)
  return done
}

// ─── Driver ─────────────────────────────────────────────────────────

const tagFilter = process.argv[2] ? new RegExp(process.argv[2]) : null
const wanted = tagFilter ? ROOMS.filter((r) => tagFilter.test(r.id)) : ROOMS

console.log(`Generating ${wanted.length} room variations via ${BRIDGE}`)
console.log(`Provider: ${PROVIDER}\n`)

let ok = 0, failed = 0
const t0 = Date.now()

for (const room of wanted) {
  process.stdout.write(`[${room.id}] `)
  const start = Date.now()
  try {
    const r = await fetch(`${BRIDGE}/rooms/${room.id}/initial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: room.prompt,
        providerId: PROVIDER,
        skipConcept: true,
      }),
    })
    const d = await consumeSse(r)
    // Read back the layout to count props + check palette landed.
    const lr = await fetch(`${BRIDGE}/rooms/${room.id}/layout`)
    const layout = (await lr.json()).layout
    const palette = layout.palette || {}
    const propCount = (layout.proposedProps || []).length
    // Flip to 'added' so the shelter build menu surfaces it.
    await fetch(`${BRIDGE}/rooms/${room.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'added' }),
    })
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(
      `ok · ${propCount} props · ${palette.wall}/${palette.floor}/${palette.accent} · ${dt}s`,
    )
    ok += 1
  } catch (err) {
    const dt = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`fail · ${err.message} · ${dt}s`)
    failed += 1
  }
}

console.log(
  `\nDone. ${ok} ok, ${failed} failed. Total ${((Date.now() - t0) / 1000).toFixed(1)}s.`,
)
process.exit(failed > 0 ? 1 : 0)

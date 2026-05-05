// POST /api/spells/generate — Vite dev middleware that turns a natural-language
// prompt into a validated spell schema using the local Claude (mirrors chat.js).
//
// Tools are disabled (allowedTools: []) so the model can't read/write files;
// it only emits text. We extract the JSON block from its final response.
//
// Stream contract (matches createSseJobStore conventions):
//   event: stage   data: { stage, message }
//   event: done    data: { schema }
//   event: error   data: { message }
import { readBody } from './frontmatter.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Read the schema spec at request time so edits to spellSchema.js are picked
// up without restarting the dev server.
const SPEC_PATH = join(__dirname, '..', 'src', 'lib', 'spellSchema.js')

function loadSchemaSpec() {
  const src = readFileSync(SPEC_PATH, 'utf8')
  // Pull the contents of the SCHEMA_SPEC template literal. Cheap regex —
  // good enough since we control the file.
  const m = src.match(/export const SCHEMA_SPEC = `([\s\S]*?)`\.trim\(\)/)
  return m ? m[1].trim() : ''
}

const SYSTEM_PROMPT = (spec) => `
You generate "spells" — particle/shader effects rendered in a Three.js scene.

The user gives you a name and a natural-language description. You respond with
a single JSON object matching the schema below. NO prose, NO markdown fences,
NO explanation — only the JSON object, ready to JSON.parse.

${spec}

Tips:
- Keep duration short (0.5–3s) unless the prompt clearly asks otherwise.
- Prefer presets for shader.vertex/fragment when in doubt.
- Use additive blending for fire, sparkles, magic, lightning, glows.
- Color curves drive most of the visual identity — pick distinctive ramps.
- maxParticles: 200–800 for most spells; 2000+ only for dense effects.
`.trim()

const SUGGEST_SYSTEM_PROMPT = `
You suggest creative ideas for spells — particle/shader effects in a Three.js
3D scene. Respond with ONLY a JSON array of 3 items, no prose, no markdown
fences. Each item:
{ "name": 1-3 word spell name,
  "prompt": short phrase, max ~10 words, evocative — colors and motion only,
            no full sentences, no flourish }

Example items:
{ "name": "Ember Burst", "prompt": "amber sparks bursting upward, fading to ash" }
{ "name": "Frost Veil",  "prompt": "pale blue mist swirling at the feet" }
`.trim()

// Pools we sample from per request so suggestions don't converge to the same
// favorites. The model is told one (element, mood, scale) triplet per slot.
const ELEMENTS = [
  'fire', 'ice', 'lightning', 'shadow', 'light', 'water', 'earth',
  'wind', 'nature', 'arcane', 'time', 'sound', 'gravity', 'blood',
  'mirror', 'dream', 'metal', 'starlight', 'fungal', 'glass',
]
const MOODS = [
  'menacing', 'playful', 'serene', 'chaotic', 'whimsical', 'ominous',
  'majestic', 'sly', 'mournful', 'jubilant', 'solemn', 'mischievous',
]
const SCALES = [
  'intimate and small', 'large and dramatic', 'fast and percussive',
  'slow and lingering', 'sprawling and ambient',
]
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function pickDistinct(arr, n) {
  const copy = arr.slice()
  const out = []
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0])
  }
  return out
}
function buildSuggestVariations() {
  const elements = pickDistinct(ELEMENTS, 3)
  return elements.map((el) => ({ element: el, mood: pick(MOODS), scale: pick(SCALES) }))
}

// Style biasing for /api/spells/generate. Pushes the model away from the
// sphere+additive+circle-billboard default by pre-picking a sprite, palette,
// motion archetype, and structural hint per request.
const SPRITE_HINTS = [
  { sprite: 'circle', when: 'soft glows, magic embers, gentle dots' },
  { sprite: 'puff',   when: 'smoke, mist, fog, drifting fluff' },
  { sprite: 'star',   when: 'twinkling magic, holy light, dreamlike' },
  { sprite: 'spark',  when: 'bright sparkles, impact flashes, electricity' },
  { sprite: 'streak', when: 'rain, falling embers, jets, comet trails' },
  { sprite: 'cross',  when: 'sparkle highlights, glints, holy starlight' },
]
const PALETTE_FAMILIES = [
  'warm (golds, ambers, deep reds)',
  'cool (cyans, ice blues, frost whites)',
  'neon (hot pinks, electric purples, acid greens)',
  'pastel (soft lilac, mint, peach, butter)',
  'monochrome with one accent (mostly white/grey + single saturated color)',
  'iridescent (cycling rainbow stops)',
  'sickly (greens and purples, cursed)',
  'pure light (white core blowing out to soft tint)',
]
const MOTION_ARCHETYPES = [
  'radial-burst — explode outward in all directions',
  'upward-stream — rising column with drift',
  'orbiting — particles spiral around the anchor',
  'falling — drift or rain downward',
  'inward-implosion — converge toward the anchor then collapse',
  'expanding-ring — flat shockwave outward, particles secondary',
  'turbulent-cloud — slow drifting with strong noise turbulence',
]
const STRUCTURAL_HINTS = [
  'must include a mesh shockwave layer (ring or torus, displaced) AND particles, with phasing — particles 0..0.6, ring 0.5..1.0',
  'must use a non-sphere emitter (cone, line, or box) for the particles',
  'must include two particle layers with contrasting sprites and overlapping phase windows',
  'must include a sphere or torus mesh with vertex displacement as the core',
  'must include a thin column or beam — use cylinder or line emitter',
  'must use spell.motion = { "kind": "projectile", "speed": 5..7 } and target a forward direction (this is a flying-projectile spell)',
  'must use spell.motion = { "kind": "orbit", "speed": 4..8, "radius": 0.6..1.2 } so the whole effect circles the caster',
  'must use spell.motion = { "kind": "lift", "speed": 0.4..0.9 } so the effect rises during its life',
  'must use spell.motion = { "kind": "arc", "speed": 4..6, "apex": 1.0..1.5 } — parabolic toss toward target',
  'must use phasing on every layer — at least three distinct phase windows that overlap to create a build-up → release sequence',
  'must use the DISSOLVE effect: a mesh layer (sphere or torus) with "dissolve": { "scale": 4..7, "edgeColor": "#warm", "direction": "outIn" } AND a particle layer with "spawnFromMesh": { "layerIndex": 0 } so particles fly off the burning surface',
  'must use the MATERIALIZE effect: a mesh layer with "dissolve": { "direction": "inOut" } so the spell forms from nothing, plus particles converging in via attractor force',
]
function buildStyleBrief() {
  const sprite = pick(SPRITE_HINTS)
  return {
    sprite: sprite.sprite,
    spriteWhen: sprite.when,
    palette: pick(PALETTE_FAMILIES),
    motion: pick(MOTION_ARCHETYPES),
    structure: pick(STRUCTURAL_HINTS),
  }
}

export function spellsApi() {
  return {
    name: 'spells-api',
    configureServer(server) {
      server.middlewares.use('/api/spells/suggest', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders?.()

        const send = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        // Use res.on('close') — req.on('close') fires spuriously after
        // readBody consumes the POST body in Node 18+ (the IncomingMessage
        // autodestroys), which would set aborted=true before we even start.
        let aborted = false
        res.on('close', () => { aborted = true })

        try {
          send('stage', { stage: 'starting', message: 'invoking local Claude…' })
          const { query } = await import('@anthropic-ai/claude-agent-sdk')
          const variations = buildSuggestVariations()
          const variationLines = variations.map((v, i) =>
            `${i + 1}. element: ${v.element} — mood: ${v.mood} — scale: ${v.scale}`
          ).join('\n')

          const q = query({
            prompt: `${SUGGEST_SYSTEM_PROMPT}\n\nProduce 3 spells, one for each slot below. Use the assigned element/mood/scale; vary names so they don't repeat past favorites.\n\n${variationLines}\n\nReturn the JSON array now.`,
            options: {
              cwd: process.cwd(),
              allowedTools: [],
              permissionMode: 'default',
              model: 'claude-haiku-4-5-20251001',
              includePartialMessages: true,
            },
          })
          send('stage', { stage: 'generating', message: 'divining ideas…' })

          let displayText = ''
          let finalText = ''
          for await (const msg of q) {
            if (aborted) break
            if (msg.type === 'stream_event') {
              const ev = msg.event
              if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                displayText += ev.delta.text
                send('partial', { text: displayText })
              }
            } else if (msg.type === 'assistant') {
              for (const b of msg.message?.content ?? []) {
                if (b.type === 'text') finalText += b.text
              }
            } else if (msg.type === 'result' && typeof msg.result === 'string') {
              if (!finalText) finalText = msg.result
            }
          }
          if (aborted) return

          const text = finalText || displayText
          console.log('[spells/suggest] final text (', text.length, 'chars):\n', text)
          const arr = extractJsonArray(text)
          if (!Array.isArray(arr) || arr.length === 0) {
            console.error('[spells/suggest] could not parse JSON array')
            send('error', { message: `no suggestions parsed: ${text.slice(0, 300)}` })
            res.end()
            return
          }
          send('done', { suggestions: arr.slice(0, 3) })
          res.end()
        } catch (e) {
          console.error('[spells/suggest] error:', e)
          send('error', { message: String(e.message ?? e) })
          res.end()
        }
      })

      server.middlewares.use('/api/spells/generate', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }

        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders?.()

        const send = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        // Use res.on('close') — req.on('close') fires spuriously after
        // readBody consumes the POST body in Node 18+ (the IncomingMessage
        // autodestroys), which would set aborted=true before we even start.
        let aborted = false
        res.on('close', () => { aborted = true })

        try {
          const { prompt } = await readBody(req)
          if (!prompt || typeof prompt !== 'string') throw new Error('missing prompt')

          send('stage', { stage: 'starting', message: 'invoking local Claude…' })

          const { query } = await import('@anthropic-ai/claude-agent-sdk')
          const spec = loadSchemaSpec()
          const brief = buildStyleBrief()
          const briefBlock = [
            'STYLE BRIEF — chosen per request to enforce visual variety. NON-NEGOTIABLE:',
            `- Every particle layer MUST set "shape": "${brief.sprite}" at the layer top level (NOT inside shader). Use this sprite (${brief.spriteWhen}) for the primary particle layer; secondary layers can vary if useful but at least one MUST use "${brief.sprite}".`,
            `- Palette family: ${brief.palette}`,
            `- Motion archetype: ${brief.motion}`,
            `- Structural rule: ${brief.structure}`,
            `If your output uses "shape": "circle" without a strong reason, you have ignored the brief — try again.`,
          ].join('\n')
          const userMessage = `${SYSTEM_PROMPT(spec)}\n\n---\n\n${briefBlock}\n\n---\n\nDescription:\n${prompt}\n\nReturn the JSON spell now. Pick a short evocative name yourself.`

          const q = query({
            prompt: userMessage,
            options: {
              cwd: process.cwd(),
              allowedTools: [],
              permissionMode: 'default',
              model: 'claude-haiku-4-5-20251001',
              includePartialMessages: true,
            },
          })

          // Two buffers:
          //   displayText — what we stream to the UI (from token deltas)
          //   finalText   — authoritative complete text (from the assistant
          //                 message at end). Parser uses finalText if present.
          let displayText = ''
          let finalText = ''
          send('stage', { stage: 'generating', message: 'generating schema…' })

          const timeoutMs = 90_000
          let timedOut = false
          const timer = setTimeout(() => { timedOut = true; aborted = true }, timeoutMs)

          try {
            for await (const msg of q) {
              if (aborted) break
              if (msg.type === 'stream_event') {
                const ev = msg.event
                if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                  displayText += ev.delta.text
                  send('partial', { text: displayText })
                }
              } else if (msg.type === 'assistant') {
                for (const b of msg.message?.content ?? []) {
                  if (b.type === 'text') finalText += b.text
                }
              } else if (msg.type === 'result' && typeof msg.result === 'string') {
                if (!finalText) finalText = msg.result
              }
            }
          } finally {
            clearTimeout(timer)
          }

          if (timedOut) {
            console.error('[spells/generate] timeout after', timeoutMs, 'ms. Partial output:\n', displayText)
            send('error', { message: `local Claude timed out after ${timeoutMs / 1000}s` })
            res.end()
            return
          }

          // Prefer the authoritative final text; fall back to the streamed
          // text if the SDK didn't emit a final assistant message for some reason.
          const textBuffer = finalText || displayText
          console.log('[spells/generate] final text (', textBuffer.length, 'chars):\n', textBuffer)
          if (!finalText) {
            console.warn('[spells/generate] no final assistant message; parsing streamed text instead')
          }

          const schema = extractJson(textBuffer)
          if (!schema) {
            console.error('[spells/generate] could not parse JSON from output above')
            send('error', { message: `could not parse JSON from model output: ${textBuffer.slice(0, 300)}` })
            res.end()
            return
          }

          send('done', { schema })
          res.end()
        } catch (e) {
          send('error', { message: String(e.message ?? e) })
          res.end()
        }
      })
    },
  }
}

// Pull JSON out of potentially-noisy output. The model may wrap output in
// markdown fences, prefix it with prose, include trailing commentary, or use
// // comments / trailing commas. We try several recovery strategies before
// giving up: strip fences, parse whole, walk every balanced candidate, and
// finally try a lenient parse that drops comments and trailing commas.
function stripFences(text) {
  return String(text || '')
    .replace(/```(?:json|JSON)?\s*\n?/g, '')
    .replace(/```/g, '')
    .trim()
}

function tryParseLenient(s) {
  try { return JSON.parse(s) } catch {}
  // Strip // line comments and /* block */ comments outside strings, then
  // remove trailing commas before } or ].
  const cleaned = stripJsonComments(s).replace(/,(\s*[}\]])/g, '$1')
  try { return JSON.parse(cleaned) } catch {}
  return undefined
}

function stripJsonComments(s) {
  let out = ''
  let inStr = false, escape = false, i = 0
  while (i < s.length) {
    const c = s[i], n = s[i + 1]
    if (inStr) {
      out += c
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function findBalanced(text, start, openCh, closeCh) {
  let depth = 0, inStr = false, escape = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (escape) { escape = false; continue }
    if (c === '\\') { escape = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === openCh) depth++
    else if (c === closeCh) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function extractBalanced(text, openCh, closeCh) {
  if (!text) return null
  const cleaned = stripFences(text)
  // 1. Try the whole text — common case when model returns pure JSON.
  const whole = tryParseLenient(cleaned)
  if (whole !== undefined) return whole
  // 2. Walk every candidate balanced span and return the first that parses.
  let cursor = 0
  while (cursor < cleaned.length) {
    const start = cleaned.indexOf(openCh, cursor)
    if (start < 0) return null
    const candidate = findBalanced(cleaned, start, openCh, closeCh)
    if (!candidate) return null
    const parsed = tryParseLenient(candidate)
    if (parsed !== undefined) return parsed
    cursor = start + 1
  }
  return null
}
function extractJson(text)      { return extractBalanced(text, '{', '}') }
function extractJsonArray(text) { return extractBalanced(text, '[', ']') }

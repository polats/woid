#!/usr/bin/env node
/**
 * Post-process saved layouts: clamp known LLM quirks that the prompt
 * doesn't reliably correct. Currently:
 *   - door / window kinds: y=0 (LLM sometimes places centre, not base)
 *
 * Idempotent. Operates on rooms whose ids match the optional prefix
 * (default "e2e-v3-").
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const PREFIX = process.argv[2] || 'e2e-v3-'

;(async () => {
  const r = await (await fetch(`${BRIDGE}/room-layouts`)).json()
  const ids = r.rooms.filter((x) => x.id.startsWith(PREFIX)).map((x) => x.id)
  for (const id of ids) {
    const lr = await fetch(`${BRIDGE}/rooms/${id}/layout`)
    if (!lr.ok) { console.log(`! ${id}: no layout`); continue }
    const layout = (await lr.json()).layout
    let fixed = 0
    for (const p of layout.props || []) {
      // Doors: y must be 0 (centre of bottom face, on the floor).
      if (p.kind === 'door' && Math.abs(p.position.y - p.size.h / 2) < 0.05) {
        p.position.y = 0; fixed += 1
      }
    }
    if (!fixed) { console.log(`· ${id}: no fix needed`); continue }
    const put = await fetch(`${BRIDGE}/rooms/${id}/layout`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    })
    console.log(`${put.ok ? '✓' : '✗'} ${id}: ${fixed} fix${fixed === 1 ? '' : 'es'}`)
  }
})().catch((err) => { console.error(err); process.exit(1) })

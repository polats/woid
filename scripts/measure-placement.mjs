#!/usr/bin/env node
/**
 * Objective placement metrics for generated rooms. Reports per room:
 *   - spread: distinct-x-positions / prop-count (1.0 = all unique, 0 = stacked)
 *   - stack-adherence: % of "on top of" relationships that resolve cleanly
 *   - zone-match (when zones present): % of props in the zone they declared
 *   - bounds: all props inside room AABB
 *   - degenerate: any prop at exactly (0,0,0)
 *
 * Usage: node scripts/measure-placement.mjs [--prefix=e2e-v3-]
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const PREFIX = args.prefix || 'e2e-v3-'

function metric(layout) {
  const props = layout.props || []
  const proposed = layout.proposedProps || []
  const zoneById = new Map(proposed.map((p) => [p.id, p.zone || null]))
  const dims = layout.dimensions

  // 1. Spread: distinct x rounded to 0.1m / count
  const xs = new Set(props.map((p) => Math.round(p.position.x * 10) / 10))
  const spread = props.length ? xs.size / props.length : 1

  // 2. Stack adherence: y of any prop near another prop's top → considered intentional stack
  const TOL = 0.06
  let stackCandidates = 0; let stackOk = 0
  for (const p of props) {
    if (p.position.y <= TOL) continue
    stackCandidates += 1
    for (const base of props) {
      if (base.id === p.id) continue
      const baseTop = base.position.y + base.size.h
      const dx = Math.abs(p.position.x - base.position.x)
      const dz = Math.abs(p.position.z - base.position.z)
      if (Math.abs(p.position.y - baseTop) < TOL && dx < base.size.w / 2 + 0.1 && dz < base.size.d / 2 + 0.1) {
        stackOk += 1; break
      }
    }
  }

  // 3. Zone match (best effort)
  let zoneCandidates = 0; let zoneOk = 0
  for (const p of props) {
    const zone = zoneById.get(p.id)
    if (!zone) continue
    zoneCandidates += 1
    const halfW = dims.width / 2; const halfD = dims.depth / 2
    if (zone === 'back-wall-left' && p.position.x < -halfW * 0.2 && p.position.z < -halfD * 0.4) zoneOk += 1
    else if (zone === 'back-wall-center' && Math.abs(p.position.x) < halfW * 0.4 && p.position.z < -halfD * 0.4) zoneOk += 1
    else if (zone === 'back-wall-right' && p.position.x > halfW * 0.2 && p.position.z < -halfD * 0.4) zoneOk += 1
    else if (zone === 'floor-left' && p.position.x < -halfW * 0.15) zoneOk += 1
    else if (zone === 'floor-center' && Math.abs(p.position.x) < halfW * 0.3) zoneOk += 1
    else if (zone === 'floor-right' && p.position.x > halfW * 0.15) zoneOk += 1
    else if (zone === 'ceiling' && p.position.y > dims.height * 0.7) zoneOk += 1
    else if (zone.startsWith('on:') || zone.startsWith('tucked-under:')) {
      const targetId = zone.split(':')[1]
      const t = props.find((q) => q.id === targetId)
      if (t) {
        if (zone.startsWith('on:') && Math.abs(p.position.y - (t.position.y + t.size.h)) < TOL) zoneOk += 1
        if (zone.startsWith('tucked-under:') && p.position.y <= TOL && Math.abs(p.position.x - t.position.x) < t.size.w) zoneOk += 1
      }
    }
  }

  // 4. Bounds
  let inBounds = 0
  for (const p of props) {
    const halfW = p.size.w / 2; const halfD = p.size.d / 2
    if (Math.abs(p.position.x) - halfW < dims.width / 2 + 0.05
        && Math.abs(p.position.z) - halfD < dims.depth / 2 + 0.05
        && p.position.y >= -0.05 && p.position.y + p.size.h <= dims.height + 0.05) inBounds += 1
  }

  // 5. Degenerate
  const atOrigin = props.filter((p) => Math.abs(p.position.x) < 0.01 && Math.abs(p.position.z) < 0.01).length

  return {
    propCount: props.length,
    spread: Number(spread.toFixed(2)),
    stackAdherence: stackCandidates ? `${stackOk}/${stackCandidates}` : 'n/a',
    zoneMatch: zoneCandidates ? `${zoneOk}/${zoneCandidates}` : 'n/a',
    inBounds: `${inBounds}/${props.length}`,
    atOrigin,
  }
}

;(async () => {
  const r = await (await fetch(`${BRIDGE}/room-layouts`)).json()
  const ids = r.rooms.filter((x) => x.id.startsWith(PREFIX)).map((x) => x.id)
  console.log(`# placement metrics — prefix=${PREFIX} rooms=${ids.length}\n`)
  const totals = { count: 0, spreadSum: 0, atOrigin: 0, props: 0, inBounds: 0 }
  for (const id of ids) {
    const lr = await fetch(`${BRIDGE}/rooms/${id}/layout`)
    if (!lr.ok) continue
    const layout = (await lr.json()).layout
    const m = metric(layout)
    console.log(`${id}`)
    console.log(`  props=${m.propCount}  spread=${m.spread}  stack=${m.stackAdherence}  zone=${m.zoneMatch}  inBounds=${m.inBounds}  atOrigin=${m.atOrigin}`)
    totals.count += 1
    totals.spreadSum += m.spread
    totals.atOrigin += m.atOrigin
    totals.props += m.propCount
    const [a] = m.inBounds.split('/').map(Number); totals.inBounds += a
  }
  if (totals.count) {
    console.log(`\n## aggregate`)
    console.log(`  rooms=${totals.count}  total props=${totals.props}`)
    console.log(`  avg spread=${(totals.spreadSum / totals.count).toFixed(2)}`)
    console.log(`  in-bounds=${totals.inBounds}/${totals.props}  at-origin=${totals.atOrigin}`)
  }
})().catch((err) => { console.error(err); process.exit(1) })

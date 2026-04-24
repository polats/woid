#!/usr/bin/env node
// Production smoke — hits /health on Railway-deployed services using
// the public woid.noods.cc hostnames. Override via env when the
// domains change or before DNS is wired:
//
//   WOID_ROOM_URL=https://rooms.woid.noods.cc/health \
//   WOID_BRIDGE_URL=https://bridge.woid.noods.cc/health \
//   WOID_RELAY_URL=https://relay.woid.noods.cc \
//   node scripts/agent-sandbox-smoke-prod.mjs

const TARGETS = [
  { name: 'room-server', url: process.env.WOID_ROOM_URL   || 'https://rooms.woid.noods.cc/health' },
  { name: 'pi-bridge',   url: process.env.WOID_BRIDGE_URL || 'https://bridge.woid.noods.cc/health' },
  { name: 'relay',       url: process.env.WOID_RELAY_URL  || 'https://relay.woid.noods.cc', expect: 'ws' },
]

let failed = 0

for (const t of TARGETS) {
  if (t.expect === 'ws') {
    try {
      const r = await fetch(t.url, { headers: { Accept: 'application/nostr+json' } })
      if (r.ok || r.status === 400) {
        console.log(`✓ ${t.name.padEnd(12)} reachable at ${t.url}`)
      } else {
        console.log(`✗ ${t.name.padEnd(12)} HTTP ${r.status} at ${t.url}`)
        failed++
      }
    } catch (err) {
      console.log(`✗ ${t.name.padEnd(12)} unreachable at ${t.url} — ${err.message}`)
      failed++
    }
    continue
  }
  try {
    const r = await fetch(t.url)
    const body = await r.json().catch(() => null)
    if (r.ok && body?.ok) {
      console.log(`✓ ${t.name.padEnd(12)} ${JSON.stringify(body)}`)
    } else {
      console.log(`✗ ${t.name.padEnd(12)} HTTP ${r.status} body=${JSON.stringify(body)}`)
      failed++
    }
  } catch (err) {
    console.log(`✗ ${t.name.padEnd(12)} unreachable — ${err.message}`)
    failed++
  }
}

if (failed > 0) {
  console.error(`\n${failed} production service(s) unreachable.`)
  process.exit(1)
}
console.log('\nAll three production services healthy.')

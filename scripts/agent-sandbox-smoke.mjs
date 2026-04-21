#!/usr/bin/env node
// Smoke check: hits /health on the three agent-sandbox services.
// Exits non-zero if any are unreachable or not ok.
//
// Usage: npm run agent-sandbox:smoke

const TARGETS = [
  { name: 'room-server', url: 'http://localhost:12567/health' },
  { name: 'pi-bridge',   url: 'http://localhost:13457/health' },
  { name: 'relay',       url: 'http://localhost:17777',        expect: 'ws' },
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
  console.error(`\n${failed} service(s) unreachable. Is 'npm run agent-sandbox:up' running?`)
  process.exit(1)
}
console.log('\nAll three services healthy.')

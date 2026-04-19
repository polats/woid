#!/usr/bin/env node
// Smoke test — verifies the dev server booted cleanly and its critical
// endpoints respond. Runs before e2e so module-resolution / syntax errors
// (e.g. a stale Vite pre-bundle) surface here instead of inside Playwright.
//
// Run:  npm run smoke

const BASE = process.env.WEB_BASE ?? 'http://localhost:5173'

const checks = [
  { name: 'web /', url: `${BASE}/`, kind: 'html' },
  { name: 'web /src/main.jsx', url: `${BASE}/src/main.jsx`, kind: 'js' },
  { name: 'api /api/tasks', url: `${BASE}/api/tasks`, kind: 'json', optional: true },
  { name: 'api /api/diagrams', url: `${BASE}/api/diagrams`, kind: 'json', optional: true },
]

let failed = 0

for (const c of checks) {
  try {
    const res = await fetch(c.url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      const body = await res.text()
      report(c, false, `${res.status} ${body.slice(0, 160)}`)
      if (!c.optional) failed++
      continue
    }
    const text = await res.text()
    if (c.kind === 'js' && /SyntaxError|does not provide an export/i.test(text)) {
      report(c, false, 'js error in response body')
      failed++
      continue
    }
    if (c.kind === 'html' && !text.includes('<div id="root">')) {
      report(c, false, 'no root element in html')
      failed++
      continue
    }
    if (c.kind === 'json') {
      try { JSON.parse(text) } catch { report(c, false, 'invalid json'); failed++; continue }
    }
    report(c, true, `${res.status} · ${text.length} bytes`)
  } catch (e) {
    report(c, false, String(e.message ?? e))
    if (!c.optional) failed++
  }
}

if (failed > 0) {
  console.error(`\n[ SMOKE: FAILED ] ${failed} check(s) broke`)
  process.exit(1)
}
console.log('\n[ SMOKE: OK ]')

function report(c, ok, detail) {
  const tag = ok ? '  OK ' : (c.optional ? '  ~~ ' : ' FAIL')
  console.log(`${tag} · ${c.name.padEnd(38)} · ${detail}`)
}

#!/usr/bin/env node
// Produces dist-mobile/ from the standard `vite build` output, patching
// only the launch HTML to (1) land on #/shelter and (2) tighten the
// viewport for native WebViews. The original dist/ is left untouched so
// the web deploy (Vercel) is unaffected.
//
// Run via `npm run mobile:build`. Idempotent — re-running overwrites
// dist-mobile/ in place.

import { execSync } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(root, 'dist')
const mobileDir = resolve(root, 'dist-mobile')

console.log('[mobile] vite build')
execSync('npx vite build', { cwd: root, stdio: 'inherit' })

if (!existsSync(distDir)) {
  console.error('[mobile] dist/ missing after vite build')
  process.exit(1)
}

console.log('[mobile] sync dist -> dist-mobile')
rmSync(mobileDir, { recursive: true, force: true })
cpSync(distDir, mobileDir, { recursive: true })

const indexPath = resolve(mobileDir, 'index.html')
let html = readFileSync(indexPath, 'utf8')

// 1. Viewport: include viewport-fit=cover so safe-area-inset-* works
//    under iOS notches/home indicators.
html = html.replace(
  /<meta name="viewport"[^>]*>/,
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />'
)

// 2. Launch directly into the Shelter route. The web app's router
//    reads window.location.hash on boot; setting it before the script
//    tag runs is enough — no source changes required.
const launchScript = `
  <script>
    // Capacitor mobile launch: land in the Shelter view.
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      location.hash = '#/shelter';
    }
    // Gemma plugin bridge self-test — runs once on boot, logs to
    // logcat via Capacitor's console pipe. Removes itself after firing
    // so it doesn't run on every navigation. No src/ code is touched
    // because window.Capacitor.Plugins.Gemma is populated by the
    // native side via @CapacitorPlugin annotation.
    // (Gemma plugin self-test was here during Phase A scaffolding.
    //  Replaced by the proper UI on the Personas page — accessible via
    //  the sidebar "Persona · Local Gemma" indicator.)
  </script>
`
html = html.replace('</head>', `${launchScript}</head>`)

writeFileSync(indexPath, html)
console.log('[mobile] dist-mobile/index.html patched (viewport + #/shelter launch)')
console.log('[mobile] done — run `npm run mobile:sync` to push into ios/android projects')

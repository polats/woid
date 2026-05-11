/**
 * Drive the room asset pipeline (refs → mock → 3D scene) for a list of
 * rooms via the running dev server. This is the same flow a human user
 * would do by clicking buttons in the drawer.
 *
 * Why playwright instead of curling the bridge directly: capturing the
 * 3D references requires WebGL, which lives in the browser. Curl + sharp
 * could fake stand-in PNGs, but FLUX-Kontext output quality depends on
 * the references actually showing the room layout — so we do the real
 * captures.
 *
 * Usage: node scripts/generate-room-assets.mjs lobby pattern-sorting
 */

import { chromium } from '@playwright/test'

const BASE = process.env.BASE_URL || 'http://localhost:5173'
const ROOMS = process.argv.slice(2)
if (!ROOMS.length) {
  console.error('usage: node scripts/generate-room-assets.mjs <roomId>...')
  process.exit(1)
}

const FLUX_TIMEOUT_MS = 600_000  // 10 min — flux-kontext cold start
const TRELLIS_TIMEOUT_MS = 900_000 // 15 min — trellis cold start can hit ~8min per the bridge's own message

;(async () => {
  console.log(`[gen] base=${BASE} rooms=${ROOMS.join(',')}`)
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await ctx.newPage()

  page.on('console', (msg) => {
    const t = msg.type()
    if (t === 'error' || t === 'warning') console.log(`[browser:${t}] ${msg.text()}`)
  })
  page.on('pageerror', (err) => console.log(`[browser:pageerror] ${err.message}`))

  console.log('[gen] navigating to /agent-sandbox')
  await page.goto(`${BASE}/#/agent-sandbox`, { waitUntil: 'networkidle' })

  // Click Rooms tab.
  console.log('[gen] switching to Rooms tab')
  await page.getByRole('tab', { name: 'Rooms' }).click()
  await page.waitForSelector('.room-card', { timeout: 10_000 })

  for (const roomId of ROOMS) {
    console.log(`\n[gen] === room: ${roomId} ===`)
    // Cards aren't keyed by id on the DOM; click by accessible text.
    // Look up the room name from the rendered DOM.
    const card = page.locator('.room-card', { has: page.locator('.sandbox3-card-name') }).filter({
      // Match by data-* won't exist, so click by index — find the card whose
      // name maps to this id. We rely on the first card whose name matches
      // the dataset map below. Simpler: use page.evaluate to pick by id.
    })
    // Better: use a data attribute. Falling back to evaluate-based click.
    const clicked = await page.evaluate((rid) => {
      const cards = Array.from(document.querySelectorAll('.room-card'))
      // Card text content includes the room name as the first line.
      // We don't have the id on DOM, so this works only if room id ≈ name.
      // Use a side-table from window if exposed; otherwise click by index.
      const idMap = {
        lobby: 'Reception',
        'pattern-sorting': 'Macrodata Refinement',
        'break-room': 'Break Room',
        'mail-room': 'Mail Room',
        archives: 'Archives',
        'wellness-counsel': 'Wellness Session',
        storage: 'Supply Closet',
        'refinement-floor': 'Refinement Floor',
        'cubicle-farm': 'Cubicle Farm',
        'conference-room': 'Conference Room',
        restroom: 'Restroom',
        'perpetuity-wing': 'Perpetuity Wing',
        'testing-floor': 'Testing Floor',
        'executive-office': 'Executive Office',
      }
      const wanted = idMap[rid]
      if (!wanted) return false
      const target = cards.find((c) => c.querySelector('.sandbox3-card-name')?.textContent?.trim() === wanted)
      if (!target) return false
      target.click()
      return true
    }, roomId)
    if (!clicked) {
      console.log(`[gen][${roomId}] could not click card — skipping`)
      continue
    }

    await page.waitForSelector('.room-drawer', { timeout: 10_000 })
    // refreshFromBridge runs on mount — give it a beat to populate prior outputs.
    await page.waitForTimeout(800)

    // Skip mock if one was loaded from disk via refreshFromBridge.
    const existingMocks = await page.locator('.room-mock-output').count()
    if (existingMocks > 0) {
      console.log(`[gen][${roomId}] mock already exists on disk — skipping flux-kontext`)
    } else {
      console.log(`[gen][${roomId}] capturing references…`)
      await page.getByRole('button', { name: 'Capture refs' }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('.room-mock-ref-thumb').length >= 4,
        { timeout: 30_000 },
      )
      console.log(`[gen][${roomId}] references captured`)
      console.log(`[gen][${roomId}] generating mock (flux-kontext, may take 1-10 min on cold start)…`)
      const mockBefore = await page.locator('.room-mock-output').count()
      await page.getByRole('button', { name: 'Generate mock' }).click()
      await page.waitForFunction(
        (before) => document.querySelectorAll('.room-mock-output').length > before,
        mockBefore,
        { timeout: FLUX_TIMEOUT_MS },
      ).catch(async () => {
        const stage = await page.locator('.room-mock-section .muted').first().textContent().catch(() => '?')
        throw new Error(`mock generation timed out — last stage: ${stage}`)
      })
      const mockUrl = await page.locator('.room-mock-output img').first().getAttribute('src')
      console.log(`[gen][${roomId}] mock ready: ${mockUrl}`)
    }

    // Skip scene if already on disk.
    const existingScene = await page.locator('.room-scene-viewer').count()
    if (existingScene > 0) {
      console.log(`[gen][${roomId}] scene already exists on disk — skipping trellis`)
    } else {
      console.log(`[gen][${roomId}] generating 3D scene (trellis, may take 1-15 min on cold start)…`)
      await page.getByRole('button', { name: /Generate scene|Regenerate scene/ }).click()
      await page.waitForFunction(
        () => document.querySelector('.room-scene-viewer') !== null,
        { timeout: TRELLIS_TIMEOUT_MS },
      ).catch(async () => {
        const stage = await page.locator('.room-scene-section .muted').first().textContent().catch(() => '?')
        throw new Error(`scene generation timed out — last stage: ${stage}`)
      })
      console.log(`[gen][${roomId}] scene ready`)
    }

    // Close drawer for next iteration.
    await page.locator('.room-drawer-close').click()
    await page.waitForSelector('.room-drawer', { state: 'detached', timeout: 5_000 }).catch(() => {})
  }

  console.log('\n[gen] all done')
  await browser.close()
})().catch((err) => {
  console.error('[gen] fatal:', err)
  process.exit(1)
})

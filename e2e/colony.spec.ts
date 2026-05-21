import { test, expect } from '@playwright/test'

// Colony smoke. Loads the route, verifies dupes render on the tile
// grid, and confirms no console errors. Per memory:
// only run this file via `npx playwright test e2e/colony.spec.ts`.

test.beforeEach(async ({ context }) => {
  // Persisted Colony state from a prior test bleeds into this one
  // (localStorage). Clear it on each spec to keep tests deterministic.
  await context.addInitScript(() => {
    try {
      localStorage.removeItem('woid.colony.v1')
      localStorage.removeItem('woid.colony.moodlets.v1.__index')
      localStorage.removeItem('woid.portable-identities.v1')
    } catch {}
  })
})

test('Colony route loads without console errors and renders dupes', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto('/#/colony')

  // Header is the first signal Colony.jsx mounted.
  await expect(page.locator('.colony-view')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.colony-header .colony-title')).toContainText('Colony')

  // Tile grid renders.
  await expect(page.locator('.colony-view .room-map')).toBeVisible()

  // Four starting dupes are in the world. Two dupes can land on the
  // same tile (RoomMap shows one avatar + a "+1" badge); count avatars
  // plus the +N in any badge so the assertion is timing-independent.
  const totalDupesVisible = await page.evaluate(() => {
    const avatars = document.querySelectorAll('.colony-view .room-tile-avatar').length
    const badges = Array.from(document.querySelectorAll('.colony-view .room-tile-badge'))
    const extra = badges.reduce((sum, el) => sum + (parseInt(el.textContent?.replace('+', '') || '0', 10) || 0), 0)
    return avatars + extra
  })
  expect(totalDupesVisible).toBe(4)

  // Resource bar is present with all four entries.
  await expect(page.locator('.colony-resource-bar li')).toHaveCount(4)

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0)
})

test('Colony dupes autonomously mine ore over time (utility AI)', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto('/#/colony')
  await expect(page.locator('.colony-view')).toBeVisible({ timeout: 10000 })

  // Read initial ore count from the resource bar (label "Ore").
  const oreLocator = page.locator('.colony-resource-bar li').filter({ hasText: 'Ore' }).locator('.v')
  const initialOre = Number(await oreLocator.textContent())
  expect(initialOre).toBe(0)

  // Let the brain run for ~4 seconds — at 4 Hz with 4 dupes that's
  // ~64 brain calls; even with proximity contention dupes should mine
  // some ore in that window.
  await page.waitForTimeout(4000)

  const finalOre = Number(await oreLocator.textContent())
  expect(finalOre, 'expected ore to be mined autonomously').toBeGreaterThan(0)

  // Spot-check: at least one dupe has moved from its starting tile.
  // Initial positions: (10,7) (12,8) (14,7) (12,6). After mining,
  // dupes should be on ore_deposit tiles (x=2).
  // Use the avatar title attribute (set by RoomMap to "name (x,y)").
  const avatarTitles = await page.locator('.colony-view .room-tile').filter({ has: page.locator('.room-tile-avatar') }).evaluateAll((tiles) =>
    tiles.map((t) => (t as HTMLElement).title),
  )
  const dupeOnLeftEdge = avatarTitles.some((title) => /\(2,/.test(title))
  expect(dupeOnLeftEdge, `expected at least one dupe to be on the left edge mining; titles=${avatarTitles.join('|')}`).toBe(true)

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0)
})

test('Colony debug panel toggles and can spawn a dupe', async ({ page }) => {
  await page.goto('/#/colony')
  await expect(page.locator('.colony-view')).toBeVisible({ timeout: 10000 })

  // Open panel via the floating DEV button (more reliable than the
  // keyboard shortcut in headless mode).
  await page.locator('.colony-debug-fab').click()
  await expect(page.locator('.colony-debug-panel')).toBeVisible()

  const dupeCount = async () => Number(await page.locator('.colony-debug-stats li').filter({ hasText: 'dupes' }).locator('span').textContent())

  expect(await dupeCount()).toBe(4)
  await page.getByRole('button', { name: /Spawn dupe/ }).click()
  expect(await dupeCount()).toBe(5)
  await page.getByRole('button', { name: /Remove last/ }).click()
  expect(await dupeCount()).toBe(4)
})

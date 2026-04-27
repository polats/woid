import { test, expect } from '@playwright/test'

/**
 * Sandbox stage layout — regression guard for "the room map disappears
 * when something is added above it". The grid template that hosts the
 * map (`sandbox3-stage` `grid-template-rows`) is sensitive to how many
 * children it has; this test asserts the map renders at non-zero size
 * and continues to render after switching to the Recap tab and back.
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'

async function reachable(url: string) {
  try {
    const r = await fetch(url)
    return r.ok || r.status === 400
  } catch { return false }
}

test.describe('sandbox stage layout', () => {
  test.beforeAll(async () => {
    test.skip(!(await reachable(`${BRIDGE}/health`)), `bridge not reachable at ${BRIDGE}`)
  })

  test('room map renders at non-zero size and survives Recap tab toggle', async ({ page }) => {
    await page.goto('/#/agent-sandbox')

    // Tabs are visible.
    const roomTab = page.locator('.sandbox3-stage-tab', { hasText: 'Room' })
    const recapTab = page.locator('.sandbox3-stage-tab', { hasText: 'Recap' })
    await expect(roomTab).toBeVisible({ timeout: 10_000 })
    await expect(recapTab).toBeVisible()

    // Room tab is active by default.
    await expect(roomTab).toHaveClass(/ active/)

    // Map renders at non-zero size — this is the assertion that
    // catches the "Recap above the map collapsed the 1fr row" bug.
    const map = page.locator('.room-map')
    await expect(map).toBeVisible({ timeout: 10_000 })
    const mapBox = await map.boundingBox()
    expect(mapBox?.width ?? 0).toBeGreaterThan(200)
    expect(mapBox?.height ?? 0).toBeGreaterThan(200)

    // Switch to Recap → map hidden, recap pane visible.
    await recapTab.click()
    await expect(recapTab).toHaveClass(/ active/)
    const recapPane = page.locator('.sandbox3-recap-pane')
    await expect(recapPane).toBeVisible()
    await expect(map).not.toBeVisible()

    // Switch back → map should re-mount at non-zero size.
    await roomTab.click()
    await expect(roomTab).toHaveClass(/ active/)
    await expect(map).toBeVisible()
    const mapBoxAfter = await map.boundingBox()
    expect(mapBoxAfter?.width ?? 0).toBeGreaterThan(200)
    expect(mapBoxAfter?.height ?? 0).toBeGreaterThan(200)
  })
})

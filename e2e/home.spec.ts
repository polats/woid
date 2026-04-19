import { test, expect } from '@playwright/test'

// Baseline sanity check — app boots, sidebar renders, no console errors.
// Copy this file as a starting point for real specs.

test('home page loads', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto('/')
  await expect(page.locator('#root')).toBeVisible()
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0)
})

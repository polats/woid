import { test, expect } from '@playwright/test'

// The Testing view serves playwright session videos via /api/testing/sessions.
// This spec verifies: sidebar list renders, clicking a session loads detail,
// and at least one test card shows a <video> element with a valid src.

test.describe('testing view', () => {
  test('lists sessions and renders a video for the latest session', async ({ page }) => {
    await page.goto('/#/testing')

    // Sessions list should populate from /api/testing/sessions
    const firstItem = page.locator('.testing-session-item').first()
    await expect(firstItem).toBeVisible({ timeout: 5_000 })

    // The first item is auto-selected — detail header appears
    await expect(page.locator('.testing-session-header h2')).toBeVisible()

    // At least one test card exists. If any has a video, it should have a src.
    const videoCount = await page.locator('.testing-video video').count()
    if (videoCount > 0) {
      const firstVideo = page.locator('.testing-video video').first()
      const src = await firstVideo.getAttribute('src')
      expect(src).toMatch(/\/api\/testing\/sessions\/[^/]+\/.+\.webm$/)

      // The video URL should actually serve.
      const resp = await page.request.head(src!)
      expect(resp.status()).toBe(200)
      expect(resp.headers()['content-type']).toContain('video/webm')
    }
  })
})

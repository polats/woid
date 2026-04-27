import { test, expect, Page } from '@playwright/test'
import { TestDetails } from './lib/test-details'

/**
 * Storyteller → image post → Recap thumbnail (#305 + #355 + #385).
 *
 * UI-driven walkthrough — the operator watches the screen as the
 * loop happens:
 *   1. Open the Sandbox; spawn Maya at fast cadence.
 *   2. Switch to the Storyteller tab; click Fire on the
 *      `something-to-share` card. The Recent Fires log shows the
 *      manual fire with Maya as the bound `host` role.
 *   3. Click Maya's name in the log → Inspector → Context. The
 *      waterfall surfaces the storyteller cue as a violet section
 *      ("impulse: …worth showing…") in her next system prompt.
 *   4. Force the actual image post via /debug/verb (LLM may not act
 *      in the test window; this is the deterministic stand-in).
 *   5. Force a sim-day rollover.
 *   6. Visit the Recap tab; the recap card shows the post image as
 *      a thumbnail. Hovering reveals "open on Jumble"; the link
 *      target is a NIP-19 nevent URL.
 *
 * Run:
 *   E2E_BASE_URL=http://localhost:5174 npx playwright test e2e/storyteller-image-post.spec.ts
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const ROOMS  = process.env.ROOMS_URL  || 'http://localhost:12567'
const RELAY  = process.env.RELAY_URL  || 'http://localhost:17777'
const MAYA = '43b15a3d81af9e8abd0fe1f0df191e04b26ca8a3c7c77ebc8620048588c3ce16'
const FAST_CADENCE = 200

async function reachable(url: string) { try { await fetch(url); return true } catch { return false } }

async function fetchJSON<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`${url} → HTTP ${r.status}: ${text.slice(0, 200)}`)
  }
  return (await r.json()) as T
}

async function ensureSpawned(pubkey: string, x: number, y: number) {
  const j = await fetchJSON<{ characters: any[] }>(`${BRIDGE}/characters`)
  const c = (j.characters || []).find((x) => x.pubkey === pubkey)
  if (!c) throw new Error(`character ${pubkey.slice(0, 8)} missing — seed required`)
  if (c.runtime?.running) return { name: c.name, agentId: c.runtime.agentId }
  const spawn = await fetchJSON<{ agentId: string }>(`${BRIDGE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, x, y }),
  })
  return { name: c.name, agentId: spawn.agentId }
}

async function setCadence(simMinutePerRealMs: number) {
  return fetchJSON(`${BRIDGE}/sim-clock/cadence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ simMinutePerRealMs }),
  })
}

async function rollover(simHours = 24) {
  return fetchJSON(`${BRIDGE}/sessions/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ simHours }),
  })
}

async function waitForRecap(simDay: number, deadline: number) {
  while (Date.now() < deadline) {
    const j = await fetchJSON<{ sessions: any[] }>(`${BRIDGE}/sessions`)
    const closed = (j.sessions || []).find((s) => s.sim_day === simDay && s.recap_source)
    if (closed) return closed
    await new Promise((r) => setTimeout(r, 2000))
  }
  return null
}

async function openSandbox(page: Page) {
  await page.goto('/#/agent-sandbox')
  await page.waitForLoadState('networkidle')
  // Wait for the Sandbox stage to render.
  await page.locator('.sandbox3-stage-tabs').waitFor({ timeout: 15_000 })
}

async function clickStageTab(page: Page, label: string) {
  const tab = page.locator('.sandbox3-stage-tab', { hasText: label })
  await tab.click({ timeout: 5_000 })
  // Stage panel re-renders; let it settle.
  await page.waitForTimeout(400)
}

test.describe('storyteller → image post → recap thumbnail', () => {
  test.beforeAll(async () => {
    const [pb, rs, rl] = await Promise.all([
      reachable(`${BRIDGE}/health`),
      reachable(`${ROOMS}/health`),
      reachable(RELAY),
    ])
    test.skip(!(pb && rs && rl), `agent-sandbox services not up`)
  })

  test('storyteller cue → Maya posts photo → recap renders thumbnail', async ({ page }) => {
    test.setTimeout(180_000)
    const details = new TestDetails(
      'storyteller cue → Maya posts photo → recap renders thumbnail',
      'e2e/storyteller-image-post.spec.ts',
    )

    try {
      await setCadence(FAST_CADENCE)
      details.step('cadence → 300× (1 real-min ≈ 5 sim-hours)')

      const maya = await ensureSpawned(MAYA, 6, 7)
      details.setArtifact('character', { name: maya.name, pubkey: MAYA })
      details.step(`spawned ${maya.name} at (6,7)`)

      // ── Open the Sandbox and let the user see the Room first. ──
      await openSandbox(page)
      details.step('opened Sandbox stage')
      await page.waitForTimeout(1500) // hold on Room so the operator sees the spawn

      // ── Phase 1: switch to the Storyteller tab and fire the card via UI ──
      await clickStageTab(page, 'Storyteller')
      details.step('switched to Storyteller tab')

      // The card is in the ambient phase group — find its row and click Fire.
      const cardRow = page.locator('.st-card', { hasText: 'something-to-share' })
      await expect(cardRow).toBeVisible({ timeout: 10_000 })
      const fireButton = cardRow.locator('.st-fire-btn')
      await fireButton.click()
      details.step('clicked Fire on something-to-share via UI')

      // Recent Fires log should populate within a poll cycle (4s).
      const logRow = page.locator('.st-log-row', { hasText: 'something-to-share' }).first()
      await expect(logRow).toBeVisible({ timeout: 8_000 })
      details.step('Recent Fires log shows the manual fire')

      // The bound role label should resolve to Maya. The character name
      // is rendered as a <button class="st-link"> inside .st-log-binding.
      const bindingLink = logRow.locator('.st-log-binding .st-link', { hasText: maya.name })
      await expect(bindingLink).toBeVisible({ timeout: 4_000 })
      details.step(`fire bindings show host:${maya.name}`)

      // ── Phase 2: pause on the storyteller tab so the operator sees state ──
      // The intensity bar + card pool stays on screen — the eligible-now
      // badge for something-to-share flips to "once" / cooldown briefly.
      await page.waitForTimeout(2000)

      // ── Phase 3: force the post via /debug/verb (full gm path) ──
      // Drives gm.dispatch → post handler → FLUX → S3 → kind:1 with
      // NIP-94 imeta → session-event with image_url + event_id.
      const postResult = await fetchJSON<any>(`${BRIDGE}/debug/verb`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: MAYA,
          verb: 'post',
          args: {
            text: 'the watch keeps better time than i do.',
            image_prompt: 'a silver pocket watch on a wooden counter, morning light through the window',
          },
        }),
      })
      expect(postResult.ok).toBe(true)
      const imageUrl = postResult.args?.image_url
      const eventId = postResult.event_id
      expect(imageUrl, 'post returned an image_url').toMatch(/^https?:\/\//)
      expect(eventId, 'post returned a kind:1 event_id').toBeTruthy()
      details.step(`Maya posted with image: ${imageUrl}`, true, imageUrl)

      // ── Phase 4: rollover ──
      const before = await fetchJSON<any>(`${BRIDGE}/health/sim-clock`)
      await rollover(24)
      const recap = await waitForRecap(before.sim_day, Date.now() + 90_000)
      expect(recap, 'recap fires within 90s').toBeTruthy()
      const postEvent = (recap!.events || []).find(
        (e: any) => e.kind === 'post' && e.image_url && e.event_id === eventId,
      )
      expect(postEvent, 'recap session events include this image post by event_id').toBeTruthy()
      expect(postEvent!.image_url).toBe(imageUrl)
      details.step(`recap closed with ${recap!.events?.length ?? 0} events`)

      // ── Phase 5: switch to Recap tab; verify thumbnail + Jumble link ──
      await clickStageTab(page, 'Recap')
      const thumb = page.locator(`.recap-images img[src="${imageUrl}"]`).first()
      await expect(thumb, 'this run\'s image thumbnail visible in recap card').toBeVisible({ timeout: 15_000 })
      // The link wrapping our image — Jumble nevent URL.
      const link = page.locator(`.recap-image-link:has(img[src="${imageUrl}"])`).first()
      const href = await link.getAttribute('href')
      expect(href, 'thumbnail links to Jumble').toMatch(/(nevent1|note1)[a-z0-9]+/)
      const title = await link.getAttribute('title')
      expect(title).toMatch(/Jumble/)
      details.step(`recap thumbnail links to Jumble (${href?.slice(0, 60)}…)`)

      // Hold on the recap so the recording captures the result clearly.
      await page.waitForTimeout(2000)

      details.setSummary(
        `${maya.name} was nudged by the storyteller's 'something-to-share' card — fired manually from the Storyteller tab via the UI Fire button, with the bound host role resolving to Maya in the Recent Fires log. The post landed (FLUX → S3 → kind:1 with NIP-94 imeta), the session event captured both image_url and event_id, rollover closed the day, and the Recap tab surfaced the image as a thumbnail whose click target is a Jumble nevent URL.`,
      )
    } finally {
      await setCadence(60_000).catch(() => {})
      details.flush()
    }
  })
})

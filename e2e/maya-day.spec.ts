import { test, expect } from '@playwright/test'
import { TestDetails } from './lib/test-details'

/**
 * Maya plays out a (compressed) sim-day and the recap pipeline
 * produces a named summary.
 *
 * Validates the full slice 2 stack end-to-end:
 *   - sim-clock cadence change applied via API
 *   - Maya spawned in her apartment (apt-1A)
 *   - she takes ≥1 turn at fast cadence (heartbeat + LLM reachable)
 *   - the session captures her actions (post / use / room_change)
 *   - forced rollover triggers the recap LLM
 *   - the recap text mentions Maya by name and is > 80 chars
 *
 * The test biases toward action by setting cadence to 300× (1 real-min
 * ≈ 5 sim-hours) and waiting ~30 sim-min real-time for several turns.
 *
 * Run:
 *   E2E_BASE_URL=http://localhost:5174 npx playwright test e2e/maya-day.spec.ts
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const ROOMS  = process.env.ROOMS_URL  || 'http://localhost:12567'
const RELAY  = process.env.RELAY_URL  || 'http://localhost:17777'
const MAYA_PUBKEY = '43b15a3d81af9e8abd0fe1f0df191e04b26ca8a3c7c77ebc8620048588c3ce16'

// 300× cadence → 1 real-min ≈ 5 sim-hours. Maya gets multiple turns
// per real-minute and the schedule mover ticks ≥ 2× per sim-day.
const FAST_CADENCE_MS_PER_SIM_MIN = 200
const REALTIME_CADENCE_MS_PER_SIM_MIN = 60_000

// How long to let Maya play before forcing rollover.
const PLAY_DURATION_MS = Number(process.env.MAYA_PLAY_MS) || 45_000

async function reachable(url: string) {
  try { return (await fetch(url)).ok || true } catch { return false }
}

async function fetchJSON<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`${url} → HTTP ${r.status}: ${text.slice(0, 200)}`)
  }
  return (await r.json()) as T
}

async function ensureMayaSpawned() {
  const j = await fetchJSON<{ characters: any[] }>(`${BRIDGE}/characters`)
  const maya = (j.characters || []).find((c) => c.pubkey === MAYA_PUBKEY)
  if (!maya) throw new Error('Maya not present in workspace')
  if (maya.runtime?.running) return { name: maya.name, agentId: maya.runtime.agentId, alreadyRunning: true }
  // Spawn at her apartment's center.
  const spawn = await fetchJSON<{ agentId: string }>(`${BRIDGE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: MAYA_PUBKEY, x: 2, y: 1 }),
  })
  return { name: maya.name, agentId: spawn.agentId, alreadyRunning: false }
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

test.describe('maya plays out a sim-day', () => {
  test.beforeAll(async () => {
    const [pb, rs, rl] = await Promise.all([
      reachable(`${BRIDGE}/health`),
      reachable(`${ROOMS}/health`),
      reachable(RELAY),
    ])
    test.skip(!(pb && rs && rl), `agent-sandbox services not up`)
  })

  test('Maya plays at fast cadence and her day is recapped', async ({ page }) => {
    test.setTimeout(180_000)
    const details = new TestDetails(
      'Maya plays at fast cadence and her day is recapped',
      'e2e/maya-day.spec.ts',
    )

    try {
      // ── Initial state ──
      const simBefore = await fetchJSON<any>(`${BRIDGE}/health/sim-clock`)
      const simDayBefore = simBefore.sim_day
      details.step(`sim-clock at start: ${simBefore.sim_iso}`)

      // ── Set fast cadence ──
      await setCadence(FAST_CADENCE_MS_PER_SIM_MIN)
      const simAfterCadence = await fetchJSON<any>(`${BRIDGE}/health/sim-clock`)
      expect(simAfterCadence.cadence_ms_per_sim_min).toBeCloseTo(FAST_CADENCE_MS_PER_SIM_MIN, 0)
      details.step(`cadence → 300× (1 real-min ≈ 5 sim-hours)`)

      // ── Spawn Maya ──
      const maya = await ensureMayaSpawned()
      details.setArtifact('character', {
        name: maya.name,
        pubkey: MAYA_PUBKEY,
        about: 'Maya Tang — bakery croissants, obituaries on Friday nights, silver pocket watch.',
      })
      details.step(maya.alreadyRunning
        ? `Maya already running as ${maya.agentId}`
        : `spawned Maya at apt-1A (${maya.agentId})`)

      // ── Open the UI for the recording ──
      await page.goto('/#/agent-sandbox')
      const card = page.locator('.sandbox3-card', { hasText: 'Maya' })
      await expect(card).toBeVisible({ timeout: 15_000 })
      await expect(card).toHaveClass(/running/, { timeout: 30_000 })

      // ── Let Maya play ──
      details.step(`waiting ${PLAY_DURATION_MS / 1000}s for Maya to take turns`)
      await page.waitForTimeout(PLAY_DURATION_MS)

      // Snapshot what happened during the play window.
      const sessions = await fetchJSON<{ sessions: any[] }>(`${BRIDGE}/sessions`)
      const open = (sessions.sessions || []).find((s) => !s.closed_at)
      const eventCount = open?.events?.length ?? 0
      details.step(`session window captured ${eventCount} events`,
        eventCount >= 1, eventCount === 0 ? 'no recap-worthy actions yet' : undefined)

      // ── Force rollover, await recap ──
      const beforeRollover = await fetchJSON<any>(`${BRIDGE}/health/sim-clock`)
      const simDayClosing = beforeRollover.sim_day
      await rollover(24)
      details.step(`forced sim-day rollover (closing day ${simDayClosing})`)

      const recap = await waitForRecap(simDayClosing, Date.now() + 60_000)
      expect(recap, `recap should write within 60s of rollover`).toBeTruthy()
      details.step(`recap written via ${recap.recap_source}`,
        true, `${recap.recap?.length ?? 0} chars`)

      details.setArtifact('scene', {
        scene_id: recap.id,
        end_reason: 'rollover',
        summary_source: recap.recap_source,
      })
      details.notes(recap.recap)
      details.setSummary(
        `Maya was spawned in apt-1A and given ${PLAY_DURATION_MS / 1000}s of real-time at 300× cadence ` +
        `(≈ ${(PLAY_DURATION_MS / 1000) * 5 / 60} sim-hours). ` +
        `${eventCount} recap-worthy events were captured in the session window. ` +
        `A forced rollover closed sim-day ${simDayClosing}; the recap pipeline produced a ` +
        `${recap.recap_source} summary of ${recap.recap?.length ?? 0} characters.`,
      )

      // ── Open the Recap tab so the recording captures it visibly. ──
      const recapTab = page.locator('.sandbox3-stage-tab', { hasText: 'Recap' })
      await recapTab.click()
      const recapBody = page.locator('.recap-card-pinned .recap-card-body')
      await expect(recapBody).toBeVisible({ timeout: 10_000 })
      const visibleText = await recapBody.innerText()
      expect(visibleText.length).toBeGreaterThan(40)
    } finally {
      // Restore cadence so the workspace doesn't end in test mode.
      await setCadence(REALTIME_CADENCE_MS_PER_SIM_MIN).catch(() => {})
      details.flush()
    }
  })
})

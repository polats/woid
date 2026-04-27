import { test, expect, type Page } from '@playwright/test'
import { TestDetails } from './lib/test-details'

/**
 * Natural-meeting end-to-end. Validates the new scene→moodlet wiring
 * from #275 / #285:
 *
 *   1. Create two test characters with seeded `about`.
 *   2. Spawn them at adjacent kitchen tiles so they're scene-mates
 *      the moment the room-server registers their presence.
 *   3. Wait for the existing scene-tracker to open and close a scene
 *      between them (4–8 turns at scene cadence; <2 min in practice).
 *   4. Assert the closed scene record carries `moodlets` and
 *      `summary_source` (either "llm" or "fallback" — both prove the
 *      wiring; LLM unavailability is graceful).
 *   5. Open one character in the drawer and assert the Vitals panel
 *      lists at least one moodlet.
 *   6. Tear down.
 *
 * Prerequisite: agent-sandbox stack (relay, room-server, pi-bridge)
 * is running. Frontend dev server (vite) is up. The test skips itself
 * if any of these are unreachable.
 *
 * Run:
 *   npx playwright test e2e/natural-meeting.spec.ts
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const ROOMS  = process.env.ROOMS_URL  || 'http://localhost:12567'
const RELAY  = process.env.RELAY_URL  || 'http://localhost:17777'
const KEEP   = process.env.KEEP_TEST_CHARACTERS === '1'

const SCENE_DEADLINE_MS = Number(process.env.SCENE_DEADLINE_MS) || 240_000  // 4 min
const SCENE_POLL_INTERVAL_MS = 2_000

const PERSONAS = [
  {
    seed: 'eira',
    about:
      'Eira — a careful baker who likes the apartment to be quiet and warm before anyone else is up. She speaks softly and notices small things first.',
  },
  {
    seed: 'felix',
    about:
      "Felix — a restless researcher who keeps strange hours. Sharp, dry, often lost in a thought he hasn't finished out loud.",
  },
]

async function reachable(url: string) {
  try {
    const r = await fetch(url)
    return r.ok || r.status === 400
  } catch {
    return false
  }
}

async function fetchJSON<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`${url} → HTTP ${r.status}: ${text.slice(0, 200)}`)
  }
  return (await r.json()) as T
}

async function createSeededCharacter(persona: { seed: string; about: string }) {
  const name = `${persona.seed}-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`
  const c = await fetchJSON<{ pubkey: string; name: string }>(`${BRIDGE}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  await fetchJSON(`${BRIDGE}/characters/${c.pubkey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ about: persona.about }),
  })
  return c
}

async function spawnAt(pubkey: string, x: number, y: number) {
  return fetchJSON<{ agentId: string }>(`${BRIDGE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, x, y }),
  })
}

async function waitForClosedScene(participants: string[], deadline: number): Promise<any> {
  while (Date.now() < deadline) {
    const j = await fetchJSON<{ scenes: any[] }>(`${BRIDGE}/scenes?limit=20`)
    const found = (j.scenes || []).find((s) =>
      s.end_reason && // closed
      participants.every((p) => s.participants?.includes(p)),
    )
    if (found) return found
    await new Promise((r) => setTimeout(r, SCENE_POLL_INTERVAL_MS))
  }
  return null
}

async function getMoodlets(pubkey: string): Promise<{ active: any[]; mood: number; band: string }> {
  return fetchJSON(`${BRIDGE}/moodlets/${pubkey}`)
}

test.describe('natural meeting → scene → moodlet', () => {
  test.beforeAll(async () => {
    const [pb, rs, rl] = await Promise.all([
      reachable(`${BRIDGE}/health`),
      reachable(`${ROOMS}/health`),
      reachable(RELAY),
    ])
    test.skip(
      !(pb && rs && rl),
      `agent-sandbox services not up — start with 'npm run agent-sandbox:up'.`,
    )
  })

  test('rooms + schedules endpoints respond', async () => {
    const r = await fetchJSON<{ grid: { width: number; height: number }; rooms: any[] }>(
      `${BRIDGE}/rooms`,
    )
    expect(r.grid.width).toBe(16)
    expect(r.grid.height).toBe(12)
    expect(r.rooms.length).toBeGreaterThanOrEqual(3)
    expect(r.rooms.some((x) => x.id === 'kitchen')).toBe(true)

    const s = await fetchJSON<{ hour: number; slot: string; targets: any[] }>(
      `${BRIDGE}/health/schedules`,
    )
    expect(['morning', 'midday', 'afternoon', 'evening']).toContain(s.slot)
    expect(Array.isArray(s.targets)).toBe(true)
  })

  test('two characters in the kitchen → scene → moodlets land', async ({ page }) => {
    test.setTimeout(SCENE_DEADLINE_MS + 60_000)
    const details = new TestDetails(
      'two characters in the kitchen → scene → moodlets land',
      'e2e/natural-meeting.spec.ts',
    )

    // ── Setup ──
    // Two adjacent kitchen tiles. The kitchen is x:0..15, y:6..9 by default;
    // two tiles diagonally placed at (3,7) and (4,8) sit inside SCENE_RADIUS=3.
    const { rooms } = await fetchJSON<{ rooms: any[] }>(`${BRIDGE}/rooms`)
    const kitchen = rooms.find((r) => r.id === 'kitchen')
    expect(kitchen, 'kitchen room must exist').toBeTruthy()

    const a = await createSeededCharacter(PERSONAS[0])
    const b = await createSeededCharacter(PERSONAS[1])
    const cleanups: string[] = [a.pubkey, b.pubkey]

    try {
      details.setArtifact('characters', [
        { name: a.name, pubkey: a.pubkey, about: PERSONAS[0].about },
        { name: b.name, pubkey: b.pubkey, about: PERSONAS[1].about },
      ])
      details.step(`created Eira + Felix with seeded about`)

      const spawnA = await spawnAt(a.pubkey, kitchen.x + 3, kitchen.y + 1)
      const spawnB = await spawnAt(b.pubkey, kitchen.x + 4, kitchen.y + 2)
      expect(spawnA.agentId, 'A should spawn').toBeTruthy()
      expect(spawnB.agentId, 'B should spawn').toBeTruthy()
      details.step(`spawned both at adjacent kitchen tiles`,
        true,
        `(${kitchen.x + 3}, ${kitchen.y + 1}) and (${kitchen.x + 4}, ${kitchen.y + 2})`,
      )

      // ── Frontend visibility ──
      await page.goto('/#/agent-sandbox')

      // Both cards visible.
      const cardA = page.locator('.sandbox3-card', { hasText: a.name })
      const cardB = page.locator('.sandbox3-card', { hasText: b.name })
      await expect(cardA).toBeVisible({ timeout: 15_000 })
      await expect(cardB).toBeVisible({ timeout: 15_000 })

      // Both running (driver attached).
      await expect(cardA).toHaveClass(/running/, { timeout: 30_000 })
      await expect(cardB).toHaveClass(/running/, { timeout: 30_000 })

      // The map is showing the room overlay (kitchen tile tinted, label visible).
      // We don't assert pixel colour; we assert the kitchen label renders.
      const kitchenLabel = page.locator('.room-region-label', { hasText: 'Kitchen' })
      await expect(kitchenLabel).toBeVisible({ timeout: 5_000 })

      // ── Wait for the scene to close ──
      const deadline = Date.now() + SCENE_DEADLINE_MS
      const scene = await waitForClosedScene([a.pubkey, b.pubkey], deadline)
      expect(scene, 'a closed scene between A and B should appear within the deadline').toBeTruthy()
      details.step(`scene closed (${scene.end_reason})`, true, `scene_id ${scene.scene_id} · ${scene.turns?.length ?? 0} turns`)

      // ── Scene record carries moodlets ──
      // The moodlets are attached asynchronously after scene close —
      // poll until they land or the deadline passes.
      let withMoodlets: any = scene
      const innerDeadline = Date.now() + 60_000
      while (
        Date.now() < innerDeadline &&
        (!withMoodlets?.moodlets || withMoodlets.moodlets.length === 0)
      ) {
        await new Promise((r) => setTimeout(r, 2_000))
        const refreshed = await fetchJSON<any>(
          `${BRIDGE}/scenes/${scene.scene_id}`,
        ).catch(() => null)
        if (refreshed) withMoodlets = refreshed
      }
      expect(withMoodlets.moodlets, 'scene record carries the moodlets array').toBeTruthy()
      expect(withMoodlets.moodlets.length).toBeGreaterThanOrEqual(1)
      expect(['llm', 'fallback']).toContain(withMoodlets.summary_source)
      for (const m of withMoodlets.moodlets) {
        expect(m.scene_id).toBe(scene.scene_id)
        expect([a.pubkey, b.pubkey]).toContain(m.pubkey)
      }
      details.step(`scene record carries moodlets (${withMoodlets.summary_source})`,
        true, `${withMoodlets.moodlets.length} entries`)
      details.setArtifact('scene', {
        scene_id: scene.scene_id,
        end_reason: scene.end_reason,
        summary_source: withMoodlets.summary_source,
      })
      details.setArtifact('moodlets', withMoodlets.moodlets.map((m: any) => ({
        pubkey: m.pubkey,
        tag: m.tag,
        weight: m.weight,
        reason: m.reason,
      })))

      // ── Per-character tracker shows the moodlet ──
      // Each participant should now have at least one active moodlet
      // tagged with the other's pubkey.
      for (const pk of [a.pubkey, b.pubkey]) {
        const result = await getMoodlets(pk)
        const fromScene = result.active.find((m) => m.scene_id === scene.scene_id)
        expect(fromScene, `${pk} has a moodlet from this scene`).toBeTruthy()
      }

      // ── UI surface: open A, switch to the Profile tab, assert
      //    the Vitals moodlet list renders the new entry. ──
      await cardA.click()
      const drawer = page.locator('.agent-drawer')
      await expect(drawer).toBeVisible({ timeout: 5_000 })

      await drawer.locator('.agent-drawer-sidetab', { hasText: 'Profile' }).click()
      const moodletsList = drawer.locator('.agent-profile-moodlet-list .agent-profile-moodlet')
      await expect(moodletsList.first()).toBeVisible({ timeout: 15_000 })
      const liveCount = await moodletsList.count()
      expect(liveCount, 'A has at least one moodlet visible').toBeGreaterThanOrEqual(1)
      const moodBadge = drawer.locator('.agent-profile-mood-badge')
      await expect(moodBadge).toBeVisible({ timeout: 5_000 })
      details.step('opened drawer → Profile; moodlet visible in Vitals panel')

      details.setSummary(
        `Eira and Felix were spawned at adjacent kitchen tiles. Within ~${Math.round((Date.now() - deadline + SCENE_DEADLINE_MS) / 1000)}s the scene-tracker opened a scene between them and closed it (${scene.end_reason}). ` +
        `The bridge ran scene-summary against the transcript and emitted ${withMoodlets.moodlets.length} moodlet${withMoodlets.moodlets.length === 1 ? '' : 's'} via ${withMoodlets.summary_source} path; each carries scene_id back to the journal entry. ` +
        `Both characters' Vitals panels now reflect the new mood.`,
      )
    } finally {
      details.flush()
      if (!KEEP) {
        for (const pk of cleanups) {
          await fetch(`${BRIDGE}/characters/${pk}`, { method: 'DELETE' }).catch(() => {})
        }
      }
    }
  })
})

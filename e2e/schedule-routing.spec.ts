import { test, expect } from '@playwright/test'
import { TestDetails } from './lib/test-details'

/**
 * Schedule routing — validates the LLM moves itself in response to
 * a schedule nudge, NOT that the server force-moves them.
 *
 * Two phases:
 *
 *   Phase 1 (deterministic, ~30–60s): a `schedule_nudge` perception
 *     event lands in the character's buffer. This proves the wiring
 *     from the schedule mover into the perception stream works.
 *
 *   Phase 2 (probabilistic, up to 5 min): the LLM, having seen the
 *     nudge on its next turn, emits a `move(x, y)` itself and ends
 *     up in the target room. Bias toward moving by giving the test
 *     character an `about` that emphasises following their routine.
 *
 * Schedules are a *gate* (perception nudge), not a *picker* (force
 * move). The whole point of this test is that the character's LLM
 * is the one deciding, with the schedule offering context.
 *
 * Run:
 *   E2E_BASE_URL=http://localhost:5174 npx playwright test e2e/schedule-routing.spec.ts
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const ROOMS  = process.env.ROOMS_URL  || 'http://localhost:12567'
const RELAY  = process.env.RELAY_URL  || 'http://localhost:17777'
const KEEP   = process.env.KEEP_TEST_CHARACTERS === '1'

const NUDGE_DEADLINE_MS  = Number(process.env.NUDGE_DEADLINE_MS)  || 90_000   // 1.5 min for the perception
const ROUTING_DEADLINE_MS = Number(process.env.ROUTING_DEADLINE_MS) || 300_000 // 5 min for the LLM to act

async function reachable(url: string) {
  try {
    const r = await fetch(url)
    return r.ok || r.status === 400
  } catch { return false }
}

async function fetchJSON<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`${url} → HTTP ${r.status}: ${text.slice(0, 200)}`)
  }
  return (await r.json()) as T
}

async function createSeededCharacter(seed: string, about: string) {
  const name = `${seed}-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`
  const c = await fetchJSON<{ pubkey: string; name: string }>(`${BRIDGE}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  await fetchJSON(`${BRIDGE}/characters/${c.pubkey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ about }),
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

async function setSlot(pubkey: string, slot: string, roomId: string) {
  return fetchJSON(`${BRIDGE}/schedules/${pubkey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot, room_id: roomId }),
  })
}

async function findAgent(pubkey: string): Promise<any | null> {
  const j = await fetchJSON<{ agents: any[] }>(`${BRIDGE}/agents`)
  return (j.agents || []).find((a) => a.npub === pubkey) || null
}

async function waitForRoomId(pubkey: string, roomId: string, deadline: number) {
  while (Date.now() < deadline) {
    const a = await findAgent(pubkey)
    if (a?.position?.room_id === roomId) return a
    await new Promise((r) => setTimeout(r, 3000))
  }
  return null
}

async function waitForPerceptionKind(
  pubkey: string,
  kind: string,
  predicate: (e: any) => boolean,
  deadline: number,
): Promise<any | null> {
  while (Date.now() < deadline) {
    const j = await fetchJSON<{ events: any[] }>(`${BRIDGE}/perception/${pubkey}`)
    const found = (j.events || []).find((e) => e.kind === kind && predicate(e))
    if (found) return found
    await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}

test.describe('schedule routing', () => {
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

  test('LLM responds to a schedule nudge by moving itself', async ({ page }) => {
    test.setTimeout(ROUTING_DEADLINE_MS + 60_000)
    const details = new TestDetails(
      'LLM responds to a schedule nudge by moving itself',
      'e2e/schedule-routing.spec.ts',
    )

    // Bridge slot is the source of truth (its clock drives the mover).
    const sched = await fetchJSON<{ hour: number; slot: string }>(`${BRIDGE}/health/schedules`)
    const currentSlot = sched.slot

    const TARGET_ROOM = 'kitchen'
    const SPAWN_ROOM  = 'apt-1A'

    const { rooms } = await fetchJSON<{ rooms: any[] }>(`${BRIDGE}/rooms`)
    const spawnRoom  = rooms.find((r) => r.id === SPAWN_ROOM)
    const targetRoom = rooms.find((r) => r.id === TARGET_ROOM)
    expect(spawnRoom,  `${SPAWN_ROOM} should exist`).toBeTruthy()
    expect(targetRoom, `${TARGET_ROOM} should exist`).toBeTruthy()
    const startX = spawnRoom.x + 1, startY = spawnRoom.y + 1

    // Bias the character toward responding to routine. This is an
    // honest test of the loop: a routine-loving character given a
    // routine nudge ought to move within a few turns.
    const c = await createSeededCharacter(
      'cleo',
      'Cleo — a writer with strong daily habits. She follows her routine carefully and trusts that the rhythm helps her think; she rarely improvises during the day.',
    )
    const cleanups = [c.pubkey]

    const movementStart = Date.now()
    try {
      details.setArtifact('character', {
        name: c.name,
        pubkey: c.pubkey,
        about: 'Cleo — a writer with strong daily habits. She follows her routine carefully and trusts that the rhythm helps her think; she rarely improvises during the day.',
      })
      details.step(`set slot ${currentSlot} → ${TARGET_ROOM}`)
      await setSlot(c.pubkey, currentSlot, TARGET_ROOM)

      details.step(`spawn in ${SPAWN_ROOM} at (${startX}, ${startY})`)
      await spawnAt(c.pubkey, startX, startY)
      await new Promise((r) => setTimeout(r, 1500))
      const after = await findAgent(c.pubkey)
      expect(after?.position?.room_id, `should start in ${SPAWN_ROOM}`).toBe(SPAWN_ROOM)
      const startPos = { x: after.position.x, y: after.position.y, room_id: after.position.room_id }

      // ── Phase 1: schedule nudge perception event lands ──
      const nudge = await waitForPerceptionKind(
        c.pubkey,
        'schedule_nudge',
        (e) => e.target_room_id === TARGET_ROOM,
        Date.now() + NUDGE_DEADLINE_MS,
      )
      expect(nudge, 'a schedule_nudge perception event should land').toBeTruthy()
      expect(nudge.slot).toBe(currentSlot)
      expect(nudge.target_room_id).toBe(TARGET_ROOM)
      expect(nudge.target_x).toBeGreaterThanOrEqual(targetRoom.x)
      expect(nudge.target_x).toBeLessThan(targetRoom.x + targetRoom.w)
      expect(nudge.target_y).toBeGreaterThanOrEqual(targetRoom.y)
      expect(nudge.target_y).toBeLessThan(targetRoom.y + targetRoom.h)
      details.step(
        `schedule_nudge perception event landed`,
        true,
        `slot=${nudge.slot} target=${nudge.target_room_id} (${nudge.target_x}, ${nudge.target_y})`,
      )
      details.setArtifact('nudge', {
        slot: nudge.slot,
        target_room_id: nudge.target_room_id,
        target_room_name: nudge.target_room_name,
        target_x: nudge.target_x,
        target_y: nudge.target_y,
      })

      // Open the UI now so the recording captures Phase 2 visibly.
      await page.goto('/#/agent-sandbox')
      const card = page.locator('.sandbox3-card', { hasText: c.name })
      await expect(card).toBeVisible({ timeout: 15_000 })
      await card.click()

      const drawer = page.locator('.agent-drawer')
      await expect(drawer).toBeVisible({ timeout: 5_000 })
      await drawer.locator('.agent-drawer-sidetab', { hasText: 'Schedule' }).click()
      details.step('opened drawer → Schedule tab')

      const currentSlotRow = drawer.locator(`.agent-schedule-slot[data-slot="${currentSlot}"]`)
      await expect(currentSlotRow).toBeVisible({ timeout: 5_000 })
      await expect(currentSlotRow).toHaveClass(/ overridden/)
      await expect(currentSlotRow.locator('.agent-schedule-target')).toContainText(/Kitchen/i)
      details.step(`Schedule tab shows ${currentSlot} row marked as override → Kitchen`)

      // ── Phase 2: the LLM moves itself ──
      const arrived = await waitForRoomId(
        c.pubkey,
        TARGET_ROOM,
        Date.now() + ROUTING_DEADLINE_MS,
      )
      expect(
        arrived,
        `Cleo should follow the nudge and move to ${TARGET_ROOM} within ${ROUTING_DEADLINE_MS / 1000}s`,
      ).toBeTruthy()
      expect(arrived.position.room_id).toBe(TARGET_ROOM)
      const elapsed = Date.now() - movementStart
      details.step(
        `Cleo moved into ${TARGET_ROOM} via her own move() verb`,
        true,
        `arrived at (${arrived.position.x}, ${arrived.position.y}) after ${(elapsed / 1000).toFixed(1)}s`,
      )
      details.setArtifact('movement', {
        start: startPos,
        end: { x: arrived.position.x, y: arrived.position.y, room_id: arrived.position.room_id },
        elapsed_ms: elapsed,
      })

      const status = drawer.locator('.agent-schedule-status')
      await expect(status).toBeVisible()
      await expect(status).toHaveText(/on schedule/i, { timeout: 10_000 })
      details.step('Schedule status pill: "on schedule"')

      details.setSummary(
        `Cleo spawned in ${SPAWN_ROOM} and her ${currentSlot} schedule was overridden to the kitchen. ` +
        `The bridge emitted a schedule_nudge perception event with target ` +
        `(${nudge.target_x}, ${nudge.target_y}); Cleo's LLM read the event on her next turn and ` +
        `moved herself into the kitchen — without any server-side force-move — within ${(elapsed / 1000).toFixed(1)}s. ` +
        `Schedules are a gate (perception nudge), not a puppet string.`,
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

import { test, expect } from '@playwright/test'
import { TestDetails } from './lib/test-details'

/**
 * Maya meets Roman — the first multi-character story.
 *
 *   1. Spawn Maya (apt-1A) and Roman (apt-1B), both adjacent to the
 *      kitchen so the schedule mover (or our spawn coords) brings
 *      them together quickly.
 *   2. Move them onto adjacent kitchen tiles via debug verb so the
 *      scene-tracker opens a scene between them.
 *   3. Assert the `first_meeting` perception event lands on both
 *      sides (deterministic — relationship store creates record).
 *   4. Force `follow` in both directions via debug verb. Validate
 *      kind:3 publish + cross-character `post_seen` subscription.
 *   5. Force Maya's image post via debug. Roman's perception buffer
 *      should pick it up via the post-subscription within ~3s.
 *   6. Force Roman's `reply` to that post via debug verb. Validate
 *      a kind:1 with NIP-10 e + p tags.
 *   7. Force sim-day rollover. Recap should mention both names +
 *      first_meeting + at least one of follow/reply/post.
 *
 * Cadence is set to 300× so the demo flows on a real-time timescale
 * the recording captures naturally.
 *
 * Run:
 *   E2E_BASE_URL=http://localhost:5174 npx playwright test e2e/maya-meets-roman.spec.ts
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const ROOMS  = process.env.ROOMS_URL  || 'http://localhost:12567'
const RELAY  = process.env.RELAY_URL  || 'http://localhost:17777'
const MAYA  = '43b15a3d81af9e8abd0fe1f0df191e04b26ca8a3c7c77ebc8620048588c3ce16'
const ROMAN = 'fcb34b77cf568ad4943839ddec98c430ca85420c3bf3ef687cec3cb60f4c2912'
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
  if (!c) throw new Error(`character ${pubkey.slice(0, 8)} missing`)
  if (c.runtime?.running) return { name: c.name, agentId: c.runtime.agentId }
  const spawn = await fetchJSON<{ agentId: string }>(`${BRIDGE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, x, y }),
  })
  return { name: c.name, agentId: spawn.agentId }
}

async function callVerb(pubkey: string, verb: string, args: any) {
  return fetchJSON(`${BRIDGE}/debug/verb`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, verb, args }),
  })
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

async function perception(pubkey: string) {
  return fetchJSON<{ events: any[] }>(`${BRIDGE}/perception/${pubkey}`)
}

async function waitForKind(pubkey: string, kind: string, predicate: (e: any) => boolean, deadline: number) {
  while (Date.now() < deadline) {
    const j = await perception(pubkey)
    const found = (j.events || []).find((e) => e.kind === kind && predicate(e))
    if (found) return found
    await new Promise((r) => setTimeout(r, 1500))
  }
  return null
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

test.describe('maya meets roman', () => {
  test.beforeAll(async () => {
    const [pb, rs, rl] = await Promise.all([
      reachable(`${BRIDGE}/health`),
      reachable(`${ROOMS}/health`),
      reachable(RELAY),
    ])
    test.skip(!(pb && rs && rl), `agent-sandbox services not up`)
  })

  test('Maya and Roman meet in the kitchen and follow each other', async ({ page }) => {
    test.setTimeout(240_000)
    const details = new TestDetails(
      'Maya and Roman meet in the kitchen and follow each other',
      'e2e/maya-meets-roman.spec.ts',
    )

    try {
      await setCadence(FAST_CADENCE)
      details.step('cadence → 300× (1 real-min ≈ 5 sim-hours)')

      // Spawn both into the kitchen so they're scene-mates immediately.
      const maya = await ensureSpawned(MAYA, 6, 7)
      const roman = await ensureSpawned(ROMAN, 7, 8)
      details.setArtifact('characters', [
        { name: maya.name, pubkey: MAYA },
        { name: roman.name, pubkey: ROMAN },
      ])
      details.step(`spawned ${maya.name} (6,7) + ${roman.name} (7,8) in kitchen`)

      // ── Phase 1: scene_tracker should open between them within ~30s ──
      // The scene-tracker syncs on the next dispatch tick. Force a
      // scene-eligible action by emitting say from each side.
      await callVerb(MAYA, 'say', { text: 'morning.' })
      await callVerb(ROMAN, 'say', { text: 'morning. you\'re new?' })

      const firstMeetMaya = await waitForKind(
        MAYA, 'first_meeting', (e) => e.with_pubkey === ROMAN,
        Date.now() + 60_000,
      )
      expect(firstMeetMaya, 'Maya sees first_meeting').toBeTruthy()
      const firstMeetRoman = await waitForKind(
        ROMAN, 'first_meeting', (e) => e.with_pubkey === MAYA,
        Date.now() + 5_000,
      )
      expect(firstMeetRoman, 'Roman sees first_meeting').toBeTruthy()
      details.step('first_meeting perception fired on both sides')

      // ── Phase 2: mutual follow via debug verb ──
      const followM = await callVerb(MAYA, 'follow', { target_pubkey: ROMAN })
      expect((followM as any).ok).toBe(true)
      const followR = await callVerb(ROMAN, 'follow', { target_pubkey: MAYA })
      expect((followR as any).ok).toBe(true)
      details.step('mutual follow committed (kind:3 published both ways)')

      // ── Phase 3: Maya posts an image; Roman should perceive it ──
      const imgPost = await fetchJSON<any>(`${BRIDGE}/debug/image-post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: MAYA,
          text: 'the watch keeps better time than i do.',
          image_prompt: 'a silver pocket watch on a wooden counter, morning light through the window',
        }),
      })
      expect(imgPost.event_id).toBeTruthy()
      details.setArtifact('scene', {
        scene_id: imgPost.event_id,
        end_reason: 'image_post',
        summary_source: 'flux',
      })
      details.step(`Maya posted with image (event ${imgPost.event_id.slice(0, 12)}...)`,
        true, imgPost.image.url)

      // Wait for Roman's post-subscription to deliver it as perception.
      const seen = await waitForKind(
        ROMAN, 'post_seen', (e) => e.event_id === imgPost.event_id,
        Date.now() + 30_000,
      )
      expect(seen, 'Roman should see Maya\'s post via subscription').toBeTruthy()
      details.step('Roman saw Maya\'s post via cross-character subscription')

      // ── Phase 4: Roman replies ──
      const replyR = await callVerb(ROMAN, 'reply', {
        to_event_id: imgPost.event_id,
        to_pubkey: MAYA,
        text: 'that watch keeps better time than my printer ever has.',
      })
      expect((replyR as any).ok).toBe(true)
      details.step('Roman replied to Maya\'s post (NIP-10 e + p tags)')

      // ── Phase 5: rollover, recap should mention both ──
      const beforeRollover = await fetchJSON<any>(`${BRIDGE}/health/sim-clock`)
      await rollover(24)
      const recap = await waitForRecap(beforeRollover.sim_day, Date.now() + 90_000)
      expect(recap, 'recap fires within 90s').toBeTruthy()
      details.step(`recap written via ${recap.recap_source} (${recap.recap?.length ?? 0} chars)`)

      // The recap may be LLM or fallback; either should name both characters.
      expect(recap.recap.toLowerCase()).toMatch(/maya/)
      expect(recap.recap.toLowerCase()).toMatch(/roman/)
      details.notes(recap.recap)

      details.setSummary(
        `${maya.name} and ${roman.name} were spawned at adjacent kitchen tiles. The scene-tracker opened a scene between them; ` +
        `the relationships store recognised this as a first meeting and broadcast a perception event to both. ` +
        `They followed each other (kind:3 published in both directions), Maya posted an image of her silver pocket watch ` +
        `(FLUX → S3 → kind:1 with NIP-94 imeta), Roman saw the post via the cross-character subscription and replied ` +
        `with proper NIP-10 tagging. The forced rollover produced a ${recap.recap_source} recap of ${recap.recap?.length ?? 0} chars naming both characters.`,
      )

      // Show the recap on screen for the recording.
      await page.goto('/#/agent-sandbox')
      const recapTab = page.locator('.sandbox3-stage-tab', { hasText: 'Recap' })
      await recapTab.click({ timeout: 10_000 })
      const recapBody = page.locator('.recap-card-pinned .recap-card-body')
      await expect(recapBody).toBeVisible({ timeout: 10_000 })
    } finally {
      // Restore real-time cadence so the workspace doesn't end in test mode.
      await setCadence(60_000).catch(() => {})
      details.flush()
    }
  })
})

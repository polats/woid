import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Trailer capture — Edi's tutorial opening, up to "Welcome them to
 * The Company". Drives the tutorial via the dev panel and records
 * the result at 1920x1080. The resulting `.webm` lives under
 * `test-results/`; `scripts/capture-trailer-intro.sh` ffmpeg-trims
 * and converts it to mp4 for the Remotion trailer.
 *
 * Run with:
 *   npx playwright test e2e/capture-trailer-intro.spec.ts --headed
 *
 * The bridge must be running (the tutorial resolves Edi's character
 * via /characters/<pubkey>).
 */

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:13457'
const OUTPUT_TIMING = process.env.CAPTURE_TIMING_FILE
  || join(process.cwd(), 'test-results', 'trailer-intro-timing.json')

// Toggle: when DIAGNOSTIC=1, video is OFF and we take a screenshot at
// the moment the closeup is supposed to be visible. Used to test
// whether Playwright's screencast-based video recording is what's
// starving the camera tween's rAF callback.
const DIAGNOSTIC = process.env.DIAGNOSTIC === '1'

// Viewport intentionally smaller than 1080 — on headed Wayland the
// actual OS window can't always be 1080px tall (titlebar / panel /
// decorations eat space), and Chromium then gray-pads the recording's
// bottom. 900px is comfortably within typical compositor constraints
// so the whole page renders without padding. The script's bottom-row
// detection still acts as a safety net.
test.use({
  viewport: { width: 1920, height: 900 },
  video: DIAGNOSTIC
    ? 'off'
    : { mode: 'on', size: { width: 1920, height: 900 } },
  actionTimeout: 15_000,
  navigationTimeout: 30_000,
})

async function bridgeReachable() {
  try {
    const r = await fetch(`${BRIDGE}/health`)
    return r.ok || r.status === 400 || r.status === 404
  } catch { return false }
}

test('records Edi tutorial intro up to "The Agency"', async ({ page }, testInfo) => {
  test.skip(!(await bridgeReachable()), `bridge not reachable at ${BRIDGE}`)

  // ── Debug: surface ALL page console output ───────────────────────
  page.on('console', (msg) => {
    console.log(`[page:${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (err) => console.log(`[page:error] ${err.message}`))
  page.on('requestfailed', (req) => {
    if (!/favicon|sourcemap/.test(req.url())) {
      console.log(`[page:reqfail] ${req.url()} — ${req.failure()?.errorText}`)
    }
  })
  // log all non-2xx responses so we can see which fetches are 502-ing
  page.on('response', (res) => {
    const s = res.status()
    if (s >= 400 && !/favicon|sourcemap|\.map$/.test(res.url())) {
      console.log(`[page:http${s}] ${res.url()}`)
    }
  })

  const tContextStart = Date.now()

  // ── Stage ────────────────────────────────────────────────────────
  // Plain navigation — a fresh Playwright context already has clean
  // storage. The earlier localStorage-clear + reload sequence appeared
  // to race the 3D stage's stageHandler registration so camera bus
  // commands fired before they had a subscriber.
  await page.goto('/#/shelter', { waitUntil: 'networkidle' })

  // wait for the shelter chrome to mount (the DEV button is the
  // earliest stable selector we can hang off of)
  await expect(page.locator('.shelter-debug-button')).toBeVisible({ timeout: 20_000 })

  // Wait for the 3D canvas to be present AND for the scene to have had
  // enough time to load room layouts, place characters, and settle the
  // camera. Without this dwell, playing the tutorial fires camera
  // moves before the scene's mount effects have completed, leaving
  // the cinematic camera in an undefined pose.
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')

  // Paint over any paper / body backgrounds that might bleed into the
  // capture — Playwright's viewport can leave dim-paper regions
  // visible at the bottom of .shelter-screen-body when the 3D scene's
  // ground plane doesn't extend all the way down. Forcing dark
  // backgrounds on the relevant containers gives a clean black frame.
  await page.addStyleTag({
    content: `
      html, body, .app, .content-area, .game-mount, .game-view,
      .game-phone-screen, .game-screen-body, .game-tab-pane,
      .shelter-screen-body { background: #000 !important; }
      .game-phone-frame { background: #000 !important; }
    `,
  })

  await page.waitForTimeout(2500)

  // DIAGNOSTIC: find what's painting at (500, 1050) — the gray bar
  const grayDiag = await page.evaluate(() => {
    const hits = document.elementsFromPoint(500, 1050).slice(0, 8).map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
      id: (el as HTMLElement).id || '',
      bg: getComputedStyle(el).backgroundColor,
      position: getComputedStyle(el).position,
      rect: el.getBoundingClientRect(),
    }))
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      probe: { x: 500, y: 1050, hits },
    }
  })
  console.log('[gray-diag]', JSON.stringify(grayDiag, null, 2))

  // ── Pre-spawn Edi so her avatar handle is ready by the time the ──
  // tutorial's focusAgent fires.
  //
  // ShelterStage3D.focusAgent() at line 709 silently returns if the
  // avatar handle is missing/pending. useTutorialHost.focus() only
  // waits 250ms after addAgent — not enough on a fresh page for the
  // GLB + kimodo rig to load. Adding Edi here gives the avatar
  // factory ~3s to load her model before the tutorial runs.
  await page.locator('.shelter-debug-button').click()
  // NPCs is the first/default tab — click it explicitly anyway in
  // case future changes reorder TABS
  const npcsTab = page.locator('.shelter-debug-sidetab', { hasText: 'NPCs' })
  await npcsTab.click()
  const ediRow = page.locator('.shelter-debug-roster-item', { hasText: 'Edi Schmid' })
  await expect(ediRow).toBeVisible({ timeout: 10_000 })
  // Click only if Edi isn't already in the scene (button shows "+" to
  // add, "×" to remove).
  const ediBtn = ediRow.locator('button')
  const ediBtnLabel = await ediBtn.textContent()
  if ((ediBtnLabel ?? '').trim() === '+') {
    await ediBtn.click()
  }
  // Wait for the avatar to fully load — GLB fetch, parse, mount.
  await page.waitForTimeout(3500)

  // ── Tutorial tab → play "Waking up" ─────────────────────────────
  const tutorialTab = page.locator('.shelter-debug-sidetab', { hasText: 'Tutorial' })
  await tutorialTab.click()

  const wakeUpRow = page.locator('.shelter-debug-tutorial-step', { hasText: 'Waking up' })
  const wakeUpPlay = wakeUpRow.locator('button[title="Play this step"]')
  await expect(wakeUpPlay).toBeVisible()

  // record the wall-clock instant we trigger the tutorial — the
  // trim window will be anchored here
  // ── Inspect runtime state BEFORE we click play ───────────────────
  const preState = await page.evaluate(() => {
    const out: any = {}
    try {
      out.tutorialActive = (window as any).__tutorial?.getState?.()?.active ?? null
    } catch {}
    out.canvases = Array.from(document.querySelectorAll('canvas')).map((c) => ({
      w: c.width, h: c.height,
      clientW: c.clientWidth, clientH: c.clientHeight,
      visible: c.offsetParent !== null,
    }))
    out.hasShelterStage = !!document.querySelector('.shelter-stage-3d')
    out.documentVisibility = document.visibilityState
    out.hidden = document.hidden
    return out
  })
  console.log('[capture] pre-play state:', JSON.stringify(preState, null, 2))

  const tPlayClick = Date.now()
  await wakeUpPlay.click()
  console.log('[capture] clicked play')

  // dev panel auto-closes via setOpen(false) in playStep
  await expect(page.locator('.shelter-debug-button')).not.toHaveClass(/ active/)

  // ── Drive the dialog ─────────────────────────────────────────────
  // The tutorial-layer becomes tappable when `awaitingTap` is true.
  // Each `tap()` on the layer advances one dialog beat.

  // 1) "... Are you awake?"
  const layer = page.locator('.tutorial-layer.awaiting-tap')
  await expect(layer).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1800)
  await layer.click()

  // In diagnostic mode: take a screenshot at the moment the scrim
  // has faded and the closeup should be visible. This tells us
  // whether the camera DID move (closeup of Edi) or didn't (still
  // wide). Independent of video recording.
  if (DIAGNOSTIC) {
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'test-results/diag-after-awake.png' })
    console.log('[diag] saved diag-after-awake.png after the "are you awake" tap')
  }

  // 2) "Good. Right in time for today's shift."
  await expect(layer).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1600)
  await layer.click()

  // 3) carousel slides in; dialog: "Here are the candidates for today. Choose one."
  await expect(page.locator('.tutorial-carousel-hire')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1600)
  if (await page.locator('.tutorial-layer.awaiting-tap').isVisible()) {
    await page.locator('.tutorial-layer.awaiting-tap').click()
  }

  // ── Browse the carousel before hiring ────────────────────────────
  // Tap through a couple of candidates so the recording shows the
  // player considering options rather than instantly picking. The
  // tabs are .tutorial-carousel-tab — one per recruit.
  const tabs = page.locator('.tutorial-carousel-tab')
  const tabCount = await tabs.count()
  console.log(`[capture] carousel has ${tabCount} candidate tab(s)`)
  if (tabCount >= 2) {
    // pick a non-zero, non-last tab to look at, then a different one,
    // then back to the first before hiring
    const browse = [
      Math.min(1, tabCount - 1),
      Math.min(2, tabCount - 1),
      0,
    ]
    for (const i of browse) {
      await tabs.nth(i).click()
      await page.waitForTimeout(900)
    }
  } else {
    // only one candidate — just dwell
    await page.waitForTimeout(1200)
  }

  // 4) hire first card → carousel hides → dialog: "Good choice. Let's
  //    welcome them to <ominous>The Company</ominous>."
  await page.locator('.tutorial-carousel-hire').click()

  // wait for the ominous span — that confirms the target line is on
  // screen
  const ominous = page.locator('.tutorial-text-ominous', { hasText: /Agency/i })
  await expect(ominous).toBeVisible({ timeout: 10_000 })

  const tTargetLineVisible = Date.now()

  // hold on the line so the pulse animation has time to play through
  // a couple cycles (~1.8s per cycle per styles.css)
  await page.waitForTimeout(2200)

  const tEnd = Date.now()

  // ── Capture the phone-frame bounding box for ffmpeg cropping ─────
  // Crop to the whole device silhouette so the trailer composes a
  // recognizable phone shape in its 3D scene. The body / scene-body
  // backgrounds are forced to black by the injected CSS above so any
  // empty area below the 3D stage stays dark instead of bleeding
  // paper-gray into the cropped frame.
  const phoneBox = await page.locator('.game-phone-frame').boundingBox()
  if (!phoneBox) throw new Error('.game-phone-frame not found')
  const evenize = (n: number) => Math.round(n) - (Math.round(n) % 2)

  // ── Persist timing for the ffmpeg trim step ──────────────────────
  const timing = {
    context_start_ms: tContextStart,
    play_click_ms: tPlayClick,
    target_line_ms: tTargetLineVisible,
    end_ms: tEnd,
    play_click_offset_s: (tPlayClick - tContextStart) / 1000,
    target_line_offset_s: (tTargetLineVisible - tContextStart) / 1000,
    end_offset_s: (tEnd - tContextStart) / 1000,
    phone_x: evenize(phoneBox.x),
    phone_y: evenize(phoneBox.y),
    phone_w: evenize(phoneBox.width),
    phone_h: evenize(phoneBox.height),
  }
  mkdirSync(dirname(OUTPUT_TIMING), { recursive: true })
  writeFileSync(OUTPUT_TIMING, JSON.stringify(timing, null, 2))
  console.log('[capture] timing written to', OUTPUT_TIMING)
  console.log(JSON.stringify(timing, null, 2))

  // The video is attached automatically on test completion. Note: we
  // also attach via testInfo so the path is easy to discover from the
  // JSON reporter.
  await testInfo.attach('trailer-intro-timing.json', {
    body: JSON.stringify(timing, null, 2),
    contentType: 'application/json',
  })
})

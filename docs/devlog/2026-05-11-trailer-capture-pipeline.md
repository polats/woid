# 2026-05-11 — trailer capture pipeline

Built `e2e/capture-trailer-intro.spec.ts` + `scripts/capture-trailer-intro.sh`
to record Edi's tutorial intro (wake-up → carousel → "The Agency"
reveal) as an mp4 that drops onto a 3D phone mesh in the openclaw-
presentation Remotion trailer. The mechanical part — driving the
tutorial via the dev panel and trimming with ffmpeg — was a one-hour
job. The other six hours were spent on environment gotchas where the
recording silently disagreed with what the page actually rendered.
Six gotchas worth flagging.

---

## Gotcha 1 — `focusAgent` silently no-ops when the avatar handle isn't loaded

**Symptom:** Spec-driven tutorial played dialog through to "The Agency"
fine; recap timing.json looked right; the recording showed dialog and
the scrim fading — but the camera **never moved**. Manual play of the
same tutorial in `npx playwright open` worked.

**Root cause:** `ShelterStage3D.focusAgent()` at line 709:

```js
const handle = liveAvatarsRef.current.get(agentId)
if (!handle || handle.pending || !handle.object3d) return
```

Silent return if Edi's avatar handle is missing/pending. The hook's
`focus()` only waits 250ms after `addAgent` — not enough on a fresh
page for the GLB + kimodo rig to load. The "Are you awake?" tap fires
focusAgent ~2s after page mount; the avatar isn't ready yet. The
tutorial step machine merrily advances; camera never tweens.

Manual play "worked" because by the time the human had navigated the
dev panel to find the play button, Edi had been auto-spawned by some
prior interaction and her avatar handle was already populated.

**Fix:** Pre-spawn Edi via the NPCs roster (`DEV → NPCs → "+" on Edi
Schmid`) **before** clicking the Tutorial tab. Then wait 3.5s for the
avatar to load. `focus()` then takes the early-return branch where
Edi is already in the store, skipping the 250ms-wait race entirely.

---

## Gotcha 2 — Wayland fractional scaling makes DOM coords ≠ recording coords

**Symptom:** Cropped mp4 had the phone in the LEFT half of the frame
with empty black on the right. DOM `getBoundingClientRect()` said
phone was at `(864, 20, 430, 860)`. Cropping at those exact coordinates
gave us a 430×860 mp4 with the phone shifted upper-left.

**Root cause:** The user's Wayland session uses fractional scaling
(~1.05x). JS reports CSS pixels (1920×900 viewport, phone at x=864).
Playwright's screencast captures at device pixels. The phone in the
1920×900 recording is actually at `(808, 16, 406, 808)` — ~5–10%
smaller than the DOM thinks.

**Fix:** Don't trust DOM coords. The script now measures the phone's
pixel bounds **directly from the recording**:

1. Build a column-presence histogram of "non-pure-black, non-gray"
   pixels (`max(r,g,b) > 10` and not `rgb(128,128,128)`-ish).
2. Find the woid sidebar's right edge as the first low-presence column.
3. The longest high-presence run past the sidebar is the phone.
4. Walk rows within that x-range top-to-bottom to find the phone's
   vertical extent.

Even-rounded for libx264. This is the source of truth for the crop;
DOM coords are no longer consulted.

---

## Gotcha 3 — Headed Chromium on Wayland can't always provide a full 1080px viewport

**Symptom:** Captured webm was 1920×1080 with everything black for the
top 960px and `rgb(128,128,128)` solid gray for the bottom 120px.
`elementsFromPoint(500, 1050)` reported `.game-view` with
`backgroundColor: rgb(0, 0, 0)` — the DOM says it's black. The
recording disagreed.

**Root cause:** The OS window can't actually be 1080px tall (titlebar,
panel, compositor decorations eat real estate). Playwright sets the
JS viewport to 1080 via CDP — JS believes `innerHeight = 1080` — but
Chromium only renders into the actually-visible area. Chrome's
screencast captures the rendered region and gray-pads the rest to
reach the requested 1080. **CSS injection cannot fix this** because
the area is never rendered to begin with.

**Fix:** Two layers:

- **Viewport reduced to 1920×900** in `test.use()`. 900px is
  comfortably within typical compositor constraints on this machine.
- **The bbox detector (gotcha 2) is the safety net.** If a future
  run hits an OS window smaller than 900px, the recording will have
  gray padding at the bottom, but the bbox detector will only measure
  the rendered phone region and never include the padding in the crop.

If you ever need the full 1080 — try `args: ['--window-size=1920,1200']`
in launchOptions so the OS window has room for decorations on top of
1080 inner. We didn't end up needing it.

---

## Gotcha 4 — Page paper-gray bleeds through where `.app`'s flex children don't fill

**Symptom:** Before Gotcha-3 was understood, the recording's bottom
~120px was paper-cream `rgb(230,...)` (not the 50% gray padding). DOM
inspection showed `.app` had `height: 100vh` and seemingly filled the
viewport, but the body background showed through.

**Root cause:** `body { background: var(--paper) }` and `.app`'s flex
children sometimes don't reach the viewport bottom in this layout
(combination of `min-height: 0` propagation and `100vh` quirks).
Whatever the structural reason, the cure was orthogonal.

**Fix:** `page.addStyleTag` injection at capture time forces dark
backgrounds on every relevant container:

```ts
html, body, .app, .content-area, .game-mount, .game-view,
.game-phone-screen, .game-screen-body, .game-tab-pane,
.shelter-screen-body, .game-phone-frame { background: #000 !important }
```

This kills any paper bleed without touching shipped CSS. (Note: the
gray Gotcha-3 talks about is from window decorations, NOT from this
bleed — they have different colors and different fixes.)

---

## Gotcha 5 — Headless Playwright is too slow for a WebGL-heavy page

**Symptom:** `npx playwright test` (no `--headed`) timed out at 30s.

**Root cause:** Headless Chromium uses SwiftShader (CPU-based WebGL)
by default. The shelter stage's 3D scene + avatar rigs are too slow
on the CPU path; the page can't finish loading + spawning Edi within
the test's 30s timeout.

**Fix:** Always run with `--headed`. The capture script hardcodes
this. Document downstream: don't try to "fix" headed mode without
understanding why it's there.

---

## Gotcha 6 — `__dirname` doesn't exist in ESM Playwright specs

**Symptom:** Spec failed with `ReferenceError: __dirname is not defined
in ES module scope` and the test runner exited with "No tests found"
before any test ran.

**Root cause:** The project's TS config emits ESM. `__dirname` is a
CommonJS global; in ESM it has to come from `import.meta.url`.

**Fix:** Replace `__dirname` with `process.cwd()` for paths in test
specs. (We only needed it to compute the default timing-JSON path.)

---

## What's now stable

The capture pipeline runs end-to-end:

1. `npm run dev` + the bridge running on `:13457`
2. `./scripts/capture-trailer-intro.sh`
3. Outputs `openclaw-presentation/public/trailer/edi-intro.mp4`

The script logs the measured phone aspect (`h/w`) after each capture.
The Remotion trailer's `PHONE_ASPECT_H_OVER_W` constant needs to be
updated to match if the aspect drifts more than a percent or two.

## What's still flaky

- The pre-spawn dwell is 3.5s. If the kimodo service is cold the GLB
  fetch can take longer; the capture would then hit Gotcha 1 again.
  Currently mitigated by always running with the bridge warm.
- `AGENCY_REVEAL_FRAME` in the trailer code is derived from
  `(target_line_offset_s - trim_start_s) * 30` in the latest
  `timing.json`. If the dialog timing changes (line length, tap
  timing in the spec), this constant has to be re-derived. Consider
  reading it from the timing file at runtime.

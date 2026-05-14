# 2026-05-14 — character card revamp, notes quest log, room + player XP curves

Shifted from cast-pipeline work into in-game systems for the day:

1. **Character card** rebuilt as a Sims/Persona-style status panel
   (stars, specialty/personality tags, energy + social bars,
   reassign-or-collect action button).
2. **Notes tab** — quest-log page chain per character, swipeable
   manilla-folder chips that fold open like a file when tapped.
3. **Bridge** gained `/characters/:pubkey/notes` + structured
   `specialty`/`personality` fields. A backfill script seeds tags on
   characters minted before the persona prompt changed.
4. **Quadratic XP curve** for the player and a per-room
   tier+level reward multiplier so a 100 xp / collection reward
   doesn't trivially level up.

Long session — about 12 gotchas worth flagging.

---

## Gotcha 1 — `c.model` is the LLM id, not a 3D rig URL

**Symptom:** Pressed Demo with 19 characters flagged `added: true`.
Empty stage. The demo's "rigged characters" filter required
`typeof c.model === 'string' && c.model` and nothing matched.

**Root cause:** A leftover comment in `demoMode.fetchRiggedCharacters`
claimed `c.model` was a URL "when the rig is on disk". It is not.
`c.model` is the LLM model id (`claude-sonnet-4-6`, `gemma-4`, etc.).
None of the curated demo characters had an LLM model assigned, so
all of them were filtered out.

**Fix:** Drop the `c.model` check from the filter. Trust `added` as
the single curator-controlled signal. Removed the misleading comment.

**Improvement:** Rename or remove `c.model` to make this category
error harder to repeat — or, if we want the original filter intent,
expose `c.rigged` derived from `kimodo.json` existence in the GET
response shaper.

---

## Gotcha 2 — the dev panel resets local progress but not the bridge

**Symptom:** "Why does Zara have 5 unlocked even when I reset?" The
dev panel reset is for re-running the tutorial; we expect every
character to start with only `About` unlocked.

**Root cause:** `resetPlayerProgress()` in `shelterStore` only wipes
`playerXp` + room `xp`/`level`. Characters live on the bridge and
their notes (and any other server-side state) survived. A test
sequence I had curled in earlier — `PUT /notes/next` → `POST
/notes/unlock` four times — had advanced Zara's chain to 5 unlocked.

**Fix:** Bulk-curled `DELETE /characters/:pubkey/notes` against all
70 characters. Re-armed Zara's first locked-next via `PUT
/notes/next` with `collectionsAtRoom: pattern-sorting count: 1` so
the tutorial smoke test works.

**Improvement:** Wire the dev panel reset to also POST a bulk
`/notes/reset` on the bridge (and any future server-side state) so
"reset" is actually a reset.

---

## Gotcha 3 — `model.glb` lands on disk but the asset view doesn't show it

**Symptom:** During the 12-char local mesh batch the bridge returned
HTTP 200 on `/characters/:pubkey/model`, files were on disk in the
container, but `AgentAssets`'s 3D viewer was empty.

**Root cause:** `AgentAssets.jsx` HEAD-probed `/model` once on mount.
If the drawer was opened before the mesh script wrote the file,
`hasModel` stayed `false` until reload.

**Fix:** Re-probe every 4 s while `hasModel` or `tposeReady` is still
false. Stops as soon as both come back true.

**Improvement:** Broadcast a `model-written` event over a bridge
websocket so the asset view doesn't have to poll. Not worth the
complexity today.

---

## Gotcha 4 — quadratic XP curve makes one collection = one level forever

**Symptom:** Pattern Sorting's `rewardXp: 100` plus a linear
`levelForXp(xp) = 1 + floor(xp/100)` meant every collect crossed
exactly one level boundary, regardless of player level. Tutorial
loved it; ongoing play was broken.

**Root cause:** Linear curve + flat reward = constant levels per
collect.

**Fix:** Triangular curve: `xpAtLevel(N) = (N-1)·N/2 · 100`. Inverse
closed-form via `sqrt`. Now leveling costs +100 xp per level — first
collect still hits level 2, but level 5 → 6 needs five collections.

**Improvement:** Tunable per-character "ability" multipliers (so a
high-spec character pulls xp faster). Deferred.

---

## Gotcha 5 — Persona 5 "stamp" overshoot needs LOW damping, not high stiffness

**Symptom:** First pass of the folder open animation set `stiffness:
320, damping: 30` on the spring. Smooth, but no overshoot, no impact
moment. Felt like a slow ease, not a P5 confidant card.

**Root cause:** Persona 5's signature is a *bounce*. Spring physics
get bounce from low damping (high oscillation), not high stiffness
(speed). 320/30 is well-damped.

**Tried:** `stiffness: 600, damping: 14`. Got the bounce — but the
modal briefly overshot its target width on phone screens, peeking
past the screen edge.

**Final fix:** Backed off to `stiffness: 360, damping: 30` (clean
settle, no overshoot), and addressed the "feels too smooth" feedback
by adding staged keyframes for cover-flip + title-stamp instead of
banking everything on a single spring.

**Improvement:** Sound. The P5 stamp is half the spring and half the
*thwack*. Without audio, even perfect physics feels muted.

---

## Gotcha 6 — `layoutId` is a shortcut, not a staged animation

**Symptom:** First version of the open animation used framer-motion's
`layoutId` shared-element transition between the chip and the open
card. One-line setup, but the result was a single tween of the whole
bounding rect — no anticipation beat, no staged folder flip, no
title-stamp moment. About 75% to the spec at best.

**Root cause:** I picked the tool first (`layoutId`) and let it
define the animation, instead of designing the animation and picking
the tool.

**Fix:** Path B — measure the chip's bounding rect manually, mount a
separately-controlled `motion.div`, run a state machine `anticipate
→ grow → flip → reveal → open` with each phase driving its own
sub-animations (cover rotateX, page opacity+scale, header strip).
Bigger code surface but actual control over the choreography.

**Improvement:** Could be done with pure CSS + setTimeout chains;
framer-motion is convenience, not requirement. ~85 kB bundle cost
for the orchestration. Worth it for the cleaner reads but worth
flagging.

---

## Gotcha 7 — the modal escaped the phone mock

**Symptom:** Modal "too wide, draws past phone left border" even
after sizing it at 78 % of `window.innerWidth`.

**Root cause:** The phone mock (`.game-phone-frame`) is a fixed
`430 px` container with `overflow: hidden`, but my modal was
portalled to `document.body` and sized from `window.innerWidth` —
which on desktop dev is 1200+ px. The "phone-sized" modal was
actually browser-sized, escaping the mock.

**Fix:** `NotesPanel` climbs the DOM on mount to find the nearest
`.game-phone-screen` ancestor and portals there. `OpenCard` sizes
itself from `portalTarget.getBoundingClientRect()`, not the window.
`.game-phone-screen` gets `position: relative` as the absolute
anchor. Fallback to `document.body` if rendered outside a phone
mock.

**Improvement:** Generic `PhonePortalTarget` context so any modal in
the codebase can portal-into-mock without re-implementing the
ancestor walk.

---

## Gotcha 8 — initial rooms got slots drawn over their walls

**Symptom:** Reception and Pattern Sorting (the layout rooms) had
the building's unbuilt-floor slot meshes drawn on top of their
walls. Only the initial rooms; built rooms were fine.

**Root cause:** `syncSlotVisibility` hid slots only where
`shelterStore.builtRooms` had a matching `gridX,gridY` cell. Layout
rooms (Reception, Pattern Sorting) are NOT in `builtRooms` — they
come from `shelter-layout.json` and live in `roomGroups` directly.
So their cells stayed marked "unbuilt" and the slot meshes drew
over them.

**Fix:** Pre-compute a `layoutRoomCells` Set on layout load
(including `gridW × gridH` spans), and union it with the
`builtRooms` cells in every `syncSlotVisibility` call.

---

## Gotcha 9 — the cover title was huge during the grow

**Symptom:** "Title becomes too big when opening or closing." The
modal cover's title was set to `font-size: 28px` and rendered the
whole time. During grow, the cover was chip-sized (~150 × 96), so
28 px text crammed the tiny cover.

**Root cause:** Title size fixed regardless of cover size.

**Fix:**
1. Shrunk the title to 22 px.
2. Wrapped the title in a `motion.div` that fades from `opacity: 0`
   to `1` only once the cover has finished growing
   (`delay: 0.18s`). Title doesn't appear at all during grow/shrink.
3. Title also fades out at the start of the cover flip — by the
   time the cover would normally hide it (`backface-visibility:
   hidden` past 90°), it's already gone.

**Improvement:** Real text-size morph (animate `fontSize` with the
grow) so the title stays continuously visible from chip-size to
modal-size. Would need `font-size` interpolation which framer-motion
supports but I didn't wire today.

---

## Gotcha 10 — closing animation overlapped the chip in the strip

**Symptom:** When the player tapped × on the open folder, the modal
played its shrink-back animation while the chip in the strip
suddenly reappeared. Two visuals overlapping for ~300 ms.

**Root cause:** `closeOpen` called `setOpenId(null)` immediately,
which un-hid the chip (`p.id === openId` flipped false). Then
`AnimatePresence` ran its `exit` animation on the modal, but the
chip was already visible.

**Fix:** Dropped `AnimatePresence` entirely for the close path.
`OpenCard` owns its own state machine — clicking × runs the close
beats (`reveal-out → flip-back → shrink`) and only calls
`onClose()` at the very end of `shrink`. `openId` stays non-null for
the full duration, so the chip stays hidden until the modal has
fully retreated to its origin rect.

---

## Gotcha 11 — chip vs cover looked different enough to flash

**Symptom:** Even with the staged grow, the chip's appearance
(lighter cream paper) and the modal cover's appearance (darker
gold gradient with hatched stripe) didn't match. So the player saw
a "color flash" the moment the chip morphed into the cover.

**Root cause:** Chip and cover were designed as different visuals
that happened to be similar shapes.

**Fix:** Made the chip a literal mini-cover: same gradient
(`#d4be78 → #c2ac5e`), same border color, same diagonal hatched
stripe at the bottom (via a `<span>` child), same centered title
layout. The grow now reads as one element changing size, not two
different visuals trading places.

---

## Gotcha 12 — drag-to-scroll on the chip strip was hacky and broke clicks

**Symptom:** Mouse drag on the chip strip did nothing. After my
first pointer-event handler patch, clicks on chips also stopped
firing.

**Root cause:** Native horizontal scroll containers don't accept
mouse drag (only touch + trackpad + wheel). My manual handler then
called `e.stopPropagation()` in capture phase on every click with a
`> 5 px` drag threshold — too aggressive, swallowed legitimate
clicks where the cursor wobbled 6 – 7 px in normal use.

**Fix:** Rip out the manual handler. Use framer-motion's
`drag="x"` on the strip with a measured `dragConstraints`. Built-in
tap-vs-drag classification — chip `onClick` fires when the cursor
hasn't moved enough to qualify as a drag. Touch + trackpad + wheel
continue to work natively (framer-motion's drag detection plays
fine with them).

**Improvement:** Scroll-snap-to-chip on drag-end. Currently the
strip free-scrolls; could land each release on the nearest chip
via `onDragEnd → animate scrollLeft`.

---

## What's in the can today

- 70 characters reset to baseline notes (Zara armed for tutorial test)
- Player + room XP curves live; first Pattern Sorting collect crosses
  level 1 → 2 still
- Folder fold-open animation that approximates Persona 5 cover-flip
  + content reveal (without the audio)
- ShelterCharacterCard / ShelterRoomCard refactor + style polish

## What's next

1. **Storyteller LLM** for notes. The bridge endpoints + engine are
   live; the storyteller that PUTs the next locked page on unlock is
   the missing piece. Local Gemma + the three-condition vocab
   (`reachLevel`, `collectionsAtRoom`, `assignedToRoomFor`).
2. **Phase 2 condition vocab**: `interactWithProp` and
   `relationshipAt` need their own state systems (prop interaction
   tracking, NPC relationship store).
3. **Dev panel "true reset"** that also DELETEs notes via the bridge.
4. **Mesh + rig retry** for Lenaia Kodali — failed UniRig with
   `TopologyError` during the local batch.
5. **Persona 5 audio** — even a single low-budget "thwack" sample at
   the impact peak would make the folder open animation land.
6. **`tier` + `level` exposure** in the demo / starter spawn payload
   so room reward multipliers apply from the first collect.

# 2026-05-07 — shelter-tutorial-cinematics

Built the wake-up tutorial scenario end-to-end: side-tab dev panel,
JSON-driven script runtime, dialog/scrim/chevron overlay, agent-card
carousel sourced from a new `starter` flag, and a multi-shot cinematic
that walks Edi off-frame and walks the chosen recruit in. Five gotchas
worth flagging — most of them reflect coupling between the cinematic
overrides and the Shelter store/sync machinery that wasn't visible
until the cinematic actually started moving things around.

---

## Gotcha 1 — `addAgent` requires `pos`; the avatar sync loop silently skips agents with `pos: null`

**Symptom:** Carousel-Hire'd recruits never appeared. Console said
`already in store? true`, the bridge fetch succeeded, the polling loop
in `animateAgentWalkIn` waited the full 4s and timed out:
`liveAvatars keys: ['npc-7a887ac2f1dc']` — only Edi mounted.

**Root cause:** The avatar-sync `useEffect` short-circuits with
`if (!a.id || !a.pos) continue` before the `factory.spawn` call. The
player addPayload built from the bridge roster had no `pos` field
(unlike NPCs, which carry `npc_default_pos`). So the agent record was
in the store but no avatar was ever spawned for it — the cinematic
was animating a wrapper that didn't exist.

**Fix:** `walkInHired` in `ShelterDebug.jsx` now resolves an "anchor"
agent (Edi → first NPC → first agent with a room) and explicitly seeds
the recruit's `pos` to that room before `addAgent`:

```js
const seedPos = anchor?.pos?.roomId
  ? { roomId: anchor.pos.roomId, localU: 0.9, localV: 0.5 }
  : null
const payload = { ...item.addPayload, pos: seedPos, state: 'idle' }
store.addAgent(payload)
```

If no anchor room is available we bail with a warning rather than
silently swallow.

---

## Gotcha 2 — `tickAgents` after spawning a player teleports them to whatever the schedule says

**Symptom:** Re-running the tutorial after a successful first run
showed the recruit at `wellness-1` (or `living-1`, varying), never at
the lobby where the cinematic expected them. The console reported
`already in store? true pos: {roomId: 'wellness-1', ...}` — different
room each session.

**Root cause:** The original `walkInHired` did `store.addAgent(...)`
**then** `tickAgents(store)`, mirroring the dev panel's `add()`
helper. For NPCs this is harmless (the resolver explicitly skips
`kind: 'npc'`), but employees are exactly what the resolver wants to
move — it reads their `scheduleId: 'worker'` and immediately routes
them to the slot's `roomId` (which the worker schedule pointed at
office-1 / break-room-1 / wellness-1 / living-1). Within one tick the
recruit was nowhere near the lobby.

**Fix:** Three layers.

1. Drop `tickAgents` from the cinematic spawn path — the resolver
   isn't useful here, the cinematic owns position for the recruit.
2. Trim the worker schedule to route every slot to `lobby` while the
   layout only contains a single room (so even when the resolver does
   run, agents stay in lobby).
3. If the recruit is already in the store at the wrong room,
   `store.updateAgent` re-parks them at the seed pos and clears
   `walkFrom/walkTo/paceFrom/paceTo/paceMode/assignment` so the
   resolver doesn't immediately pull them away again.

The schedule trim lives in `src/lib/shelterStore/schedules.js`. When
more rooms come back online, the per-action room ids restore and the
resolver picks up where it left off — the FSM and tick code never
changed.

---

## Gotcha 3 — `tutorialPosition` only blocks the snapshot-driven sync, not the per-frame walker/pacer lerp

**Symptom:** "Disappears for a few frames while walking in." The
recruit would render briefly, then jitter or vanish, before snapping
back into place at the cinematic's target. Looked like a flicker but
the wrapper was actually being yanked between the cinematic's target
and the resolver's `paceFrom → paceTo` interpolation.

**Root cause:** Two separate position-write code paths exist in
`ShelterStage3D.jsx`:

- The **snapshot-sync** effect that writes `wrapper.position` from
  `projector.projectLocal(...)` whenever the Shelter store snapshot
  changes (gated on `tutorialPosition`).
- The **walker/pacer per-frame loop** in the render tick that reads
  the agent's `walkFrom/walkTo` or `paceFrom/paceTo` and lerps
  `wrapper.position` directly via `handle.object3d.position.set(...)`,
  with NO `tutorialPosition` check.

The 4Hz `useShelterTick` runs the resolver, which sets `paceFrom/paceTo`
on idle employees. The recruit was a kind:'employee' agent without a
clear pacing-skip signal, so the pacer started moving them — and the
per-frame loop overwrote the wrapper position several times per second,
fighting the cinematic's `tutorialPosition` writes.

**Fix:** Gate the per-frame walker/pacer the same way snapshot-sync is
gated:

```js
if (handle.tutorialPosition || handle.tutorialRole) continue
```

The 4Hz tick keeps running (so other agents pace normally), but
cinematic-controlled wrappers stay put.

**Lesson:** When you introduce a "this code owns the wrapper now"
override, audit *every* place that writes to `wrapper.position` /
`wrapper.rotation` / motion. There were three: snapshot sync,
walker/pacer per-frame, and the focused face-camera per-frame —
each needed its own override gate.

---

## Gotcha 4 — focused face-camera snap-rotated the wrapper through the long way around, reading as a 1-frame "missing" character

**Symptom:** When the recruit finished walking and `focusHired` kicked
in, the wrapper appeared to disappear for a frame or two before the
red outline + wave pose stabilised. Reproducible only at the
walk-end → focus-start transition.

**Root cause:** The face-camera per-frame loop at the end of the render
tick directly assigned `wrapper.rotation.y = atan2(dx_local, dz_local)`
each frame for the focused agent. At end-of-walk the wrapper was at
`rotation.y = +π/2` (walking right). Face-camera target was `~0`
(facing camera). One-frame snap from `+π/2` to `~0` — but the focus
tween also moved the camera, and on subsequent frames `dx_local /
dz_local` shifted, so rotation continued jumping. Worse, the snap could
take the long way around through `±π`, briefly flipping the wrapper
through angles where the rig folded weirdly enough to read as missing.

**Fix:** Replace the snap with a damped lerp toward `target`, with
shortest-signed-angle wrapping so a `+π/2 → 0` transition rotates 90°
clockwise instead of 270° the long way:

```js
let delta = target - cur
while (delta > Math.PI) delta -= Math.PI * 2
while (delta < -Math.PI) delta += Math.PI * 2
wrapper.rotation.y = Math.abs(delta) < 0.005
  ? target
  : cur + delta * 0.18
```

Damping `0.18` per frame settles in roughly half a second. The exact
target gets snapped once `|delta| < 0.005` so rotation doesn't drift
forever.

**Lesson:** Per-frame "snap to target" rotations are fine when the
target is stable. They become flickery the moment the target moves —
which any focus-tween will do. Lerp by default; only snap when there's
a reason.

---

## Gotcha 5 — focused-agent face-camera fights the cinematic walk's heading

**Symptom:** Earlier in the session: when Edi started walking left
during step 1's reveal, he faced **forward** (toward the camera)
instead of left. Mid-walk his orientation read as a quarter-turn
rotation that didn't match his motion.

**Root cause:** Edi was the focused agent (the wake-up step set
`closeup: true, motion: "arms-crossed"` in the moment before the
fade). Face-camera in the render tick rotates focused agents to face
the camera each frame — which directly overrode the `atan2(dx, dz)`
heading that `animateAgentWalk` set at walk start.

**Fix:** Skip face-camera while a cinematic walk is animating, by
gating on `!handle.tutorialRole`:

```js
if (handle && !handle.pending && handle.object3d && !handle.tutorialRole) {
  /* face-camera */
}
```

Cinematic walks own their own heading. As soon as the walk completes,
`tutorialRole` clears and face-camera resumes (smoothed by gotcha 4's
lerp). Pairs with gotcha 3 — both came from the same audit of
"everywhere a focused agent's transform gets written".

---

## Bonus — `clearTutorialOverrides` had to actively snap positions, not just clear flags

**Symptom:** Selecting **Reset** in the dev panel cleared
`tutorialPosition` / `tutorialRole`, but Edi stayed wherever the
cinematic walked him to. The next tutorial run started with Edi at
the off-screen-left position the previous run left him at.

**Root cause:** Clearing the overrides only matters if some downstream
write puts the wrapper back in the right place. The snapshot sync
only fires on snapshot CHANGE — and `reset()` doesn't change the
store snapshot, just the runtime state.

**Fix:** `clearTutorialOverrides` now also re-projects every agent's
snapshot position into world space and force-snaps the wrapper, plus
resets `rotation.y = 0`:

```js
for (const [id, handle] of liveAvatarsRef.current.entries()) {
  handle.tutorialPosition = null
  handle.tutorialRole = null
  handle.object3d.rotation.y = 0
  const ag = snapshot.agents?.[id]
  const proj = projector.projectLocal(ag.pos.roomId, ag.pos.localU, ag.pos.localV)
  if (proj) handle.object3d.position.set(proj.world.x, proj.world.y, proj.world.z)
}
```

Plus the Reset button (and `playStep` start) wipes any non-NPC agents
from the store so leftover recruits from a prior run don't pile up at
stale rooms.

---

## What's now stable

The wake-up tutorial plays end-to-end:

1. Black scrim, Edi's voice asks "are you awake?", chevron tap.
2. Camera cuts to a closeup on Edi (arms-crossed pose, no outline) under
   the scrim, then the scrim fades.
3. "Good. Right in time for today's shift." dialog appears.
4. Carousel slides up with three folder-tabbed `starter`-tagged
   recruits. Player taps a Hire button.
5. Carousel + dialog slide down; camera pulls back from closeup to
   room view.
6. "Good choice. Let's welcome them to The Company." dialog.
7. Edi walks left, camera pans in lockstep.
8. Camera continues left past Edi.
9. The chosen recruit walks in from the left, settles at camera centre.
10. `focusHired` highlights them with the red outline + wave motion.

The runtime, overlay UI, and Hire-card carousel are reusable; `play()`,
`reset()`, `setHired()`, `subscribe()`, and the `cameraTo` / `walkAgent`
/ `panCamera` / `walkInHired` / `focusHired` actions form the public
surface. `scripts.json` is intentionally the only thing the tutorial
designer needs to edit.

## What's hardcoded and ripe for refactor

The `walkInHired` action is name-coupled to `state.hiredPubkey` — if
we ever want a *different* carousel cinematic in another step we'd
have to add a parallel action. `focusHired` has the same coupling.
The carousel itself only knows the `starter` flag. All of these should
either generalise (`walkInAgent { pubkey | role | hiredKey }`) or get
explicit params. To be discussed in the post-commit refactor pass.

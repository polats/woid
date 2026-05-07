# 2026-05-07 — kimodo-loop-seams-and-tag-roles

Built two coupled features in one session: kimodo seam-pose loop generation,
and a user-extensible tag registry on top of `animationLibrary` that drives
the Shelter avatar role swap (walk on lerp, idle on rest, wave on rest, etc.).
Three gotchas worth flagging, plus one known-still-broken behaviour to pick
up next session.

Commits:
- kimodo `polats/kimodo-motion-api@e1cb7cf` — `/generate` accepts
  `seam_pose: { anim_id, frame_idx, direction? }`, persists `posed_joints`
  on every record, builds a `FullBodyConstraintSet` for the loop.
- woid `polats/woid@cc39496` — Animations tab seam picker + dial, tag
  registry with localStorage migration, Shelter walk role swap.
- woid (uncommitted at write time) — pace move/rest cycle + compass
  flip + reset button.

---

## Gotcha 1 — `FullBodyConstraintSet` pins **world XZ** at every keyframe; pinning the same seam at frame 0 and frame N-1 freezes the model in place

**Symptom:** First version of the loop API pinned both endpoints to the
same seam pose. Generation produced "an animation that stays in the same
frame with slight variations" — not motion. The model was clearly
respecting the constraint perfectly; the constraint was just wrong.

**Root cause:** `FullBodyConstraintSet.update_constraints` pushes four
parallel targets per keyframe — `global_joints_positions`,
`smooth_root_2d`, `root_y_pos`, `global_root_heading`. Joint positions
are world-frame absolute, so pinning them at the *same* world XZ on both
endpoints tells the diffusion model "be at this XZ at start, **and**
back at this XZ at end." The only motion that satisfies both keyframes
is hovering near that XZ. `post_processing=True` makes it tighter, not
looser.

**Fix:** For translating loops, offset the second keyframe along the
seam's heading. `_build_seam_constraint` now takes an optional
`direction` (seam-local `[x, z]` unit vector) and a distance heuristic
(`max(0.5, seconds × 1.0)` m). It rotates the local direction into
world frame using the seam's heading, then offsets frame N-1's joint
positions and `smooth_root_2d` by that vector. When `direction` is
None → endpoints share XZ → in-place loop (idle / wave) works the
same as before. See `kimodo/scripts/run_motion_api.py`
`_build_seam_constraint`.

**Trap for next time:**

- **The "FullBody" in `FullBodyConstraintSet` includes world position,
  not just pose.** If you ever want pose-only matching (rotations, no
  translation), there's no built-in constraint type — you'd have to
  subclass and skip `smooth_root_2d` + decompose joint positions into
  pelvis-relative form.
- **The four targets push as a bundle.** You can't pin "joints but not
  smooth_root" cleanly without overriding `update_constraints`.
- **Symptom shape: motion that "respects the seam too well".** If the
  generated clip looks like the seam pose with tiny variations, the
  constraint is over-determined, not under-determined. Look for an
  axis you didn't mean to pin.

---

## Gotcha 2 — `compute_global_heading` returns `(cos θ, sin θ)`, but θ is defined so that **+Z is forward**, so the tuple maps to (Z, X) — not (X, Z)

**Symptom:** First fix to gotcha 1 added an offset along
`(heading_2d[0], heading_2d[1])` interpreted as `(X, Z)`. Numerically
the loop closure was perfect (0.0 mm pose RMSE; 2.50 m displacement).
Visually the avatar walked **sideways** for a "walk forward" prompt.
Verified via curl + JSON arithmetic: displacement was at ±90° from the
expected forward direction. RMSE-only verification missed this.

**Root cause:** `kimodo/motion_rep/feature_utils.py`
`compute_heading_angle` is `atan2(Δhip_z, -Δhip_x)`. At angle θ=0 the
character faces +Z; at θ=π/2 it faces +X. Then `compute_global_heading`
stacks `(cos θ, sin θ)`. So the canonical interpretation is:

```
world_forward_direction = (sin θ, cos θ)   # i.e. (X, Z)
world_right_direction   = (cos θ, -sin θ)
```

**Not** `(cos, sin) → (X, Z)`, which is what you'd assume reading the
pair left-to-right.

**Fix:** Swap the components. `forward_xz = (heading_2d[1], heading_2d[0])`
in the API; for arbitrary seam-local `(dx, dz)` the world XZ is
`(dx·cos + dz·sin, -dx·sin + dz·cos)`. Comments in
`_build_seam_constraint` explain the math.

**Trap for next time:**

- **Numeric tests verify magnitudes, not directions.** RMSE and
  displacement-distance both passed while the offset was 90° off. To
  catch direction bugs early, check that `dz > |dx|` for a forward
  walk, or print the displacement angle vs. expected.
- **kimodo's coordinate convention: +Z forward, +X right, +Y up.**
  `first_heading_angle=0` means facing +Z. Any frontend code that
  assumes "forward = +X" (a common Unity-style assumption) will be
  90° off.
- **`(cos, sin)` doesn't mean (X, Y) — it means (cos of the angle, sin
  of the angle).** Whether they map to X, Y, Z depends entirely on the
  rotation convention. Look up the `atan2` call that produced the
  angle.

---

## Gotcha 3 — soft constraints leave ~2 cm seam slop until you flip `post_processing=True`

**Symptom:** Even after fixing the constraint structure, the loop wrap
showed a single-frame visual pop. Numerically frame 0 vs frame N-1 had
~2.3 cm joint RMSE — close enough to look fine on a paused screenshot,
visible enough that scrubbing the looped clip showed a stutter every
75 frames.

**Root cause:** Diffusion constraints are *soft* — the model trades
constraint loss against text-prompt loss against denoising priors.
Without explicit enforcement, the seam pose is approximated, not
matched. We were getting ~96% of the way there.

**Fix:** Pass `post_processing=True` to `model(...)` whenever
`constraint_lst` is non-None. The post-processor runs constraint
enforcement (foot-skate cleanup is a side benefit) and locks frame
0/frame N-1 to the requested seam to ~0.0 mm. Unconstrained calls still
default to `post_processing=False` so existing clips' character isn't
changed retroactively.

**Trap for next time:**

- **A "constraint" in diffusion-land is a target, not a guarantee.**
  Always check whether the model's API has a separate enforcement
  step. kimodo does (`post_processing`); enabling it is the difference
  between "soft suggestion" and "hard pin".
- **2 cm sounds tiny. It's not.** At 30 fps that's ~60 cm/s of
  apparent velocity at the wrap, which the eye reads as a teleport.
  Loop-quality work: aim for sub-millimetre, not sub-centimetre.

---

## Gotcha 4 — `wave` is a built-in tag with **no built-in default clip**, so an unassigned wave silently plays idle

**Symptom:** After wiring the pace move/rest cycle, the agent visibly
stopped at each waypoint and animated — but never *waved*, even though
the rest role was randomly choosing 'wave'. Nothing in the console
indicated anything was wrong.

**Root cause:** `BUILTIN_DEFAULTS` in `animationLibrary.js` only seeds
an idle clip (`'342711ffd11f'`). For any tag without an entry there,
`getRoleId(tag)` walks: explicit assignment → built-in default → idle
fallback → null. So an unassigned wave resolves all the way down to
the idle clip and plays. The agent looked correct (it animated; it
held position) but never executed the intent.

**Fix:** No code fix needed — the user has to generate a waving clip
in the Animations tab and click "Use as wave". Worth noting that
`BUILTIN_TAGS` includes 'wave' to surface it in the Tags grid by
default.

**Trap for next time:**

- **`getRoleId` falls back silently.** When debugging "why isn't role
  X playing", first call `animationLibrary.getAssignment(tag)` — if
  that's null, the tag is using the idle fallback regardless of what
  the FSM asks for.
- **For new built-in tags that need a different feel from idle,
  either ship a default clip id or surface "unassigned" loudly in
  the UI.** Currently the UI shows "DEFAULT" next to defaulted tags;
  could be more aggressive (e.g., a warning badge) for tags whose
  default is "fall back to idle".

---

## Gotcha 5 — localStorage shape changed; stale assignments looked "lost"

**Symptom:** First time loading the new tag UI, prior walk assignments
appeared as "unassigned". The user had explicitly assigned a clip in
the previous slice but the new UI showed nothing.

**Root cause:** Earlier slice persisted under
`woid.animationRoles` as a flat `{ tag: animId }` map. Tag-registry
slice changed both shape (now `{ tags, assignments }`) and key
(`woid.animationTags`). New code reads new key only.

**Fix:** One-shot migration in `readState()` — if the new key is empty
but the legacy key is present, parse the flat map, project into the
new shape, write it under the new key, remove the legacy key. Idempotent.

**Trap for next time:**

- **Renaming a localStorage key without a migration silently loses
  user data.** Always migrate or version. The grace period for "I'll
  do it later" is approximately zero — by the time the user reports
  it, they've already lost trust in the persistence.
- **Migration check goes in `readState()`, not in some init effect.**
  It runs once per page load, deduplicates itself naturally, and
  any consumer that calls `readState()` benefits.

---

## Open issue — heuristic loop distance vs. natural walking speed mismatch causes back-walking

**Symptom:** "On walk animations the character sometimes ends by
walking back." Visible in clips where the prompt's natural walking
speed differs significantly from our `seconds × 1.0 m/s` heuristic.

**Diagnosis:** With `direction` set, the constraint pins frame N-1 to
seam-pose-offset-by-(seconds × 1.0 m). For a "walk forward at a steady
pace" prompt at 2.5 s, the model's *natural* walk distance is ~3.86 m
(measured from an unconstrained generation), but our target is 2.50 m.
The model walks its full natural distance, then post-processing drags
it back to land at 2.50 m at frame N-1. Visually: forward stride →
backtrack.

**Why we deferred:** The robust fix is two-pass — run an unconstrained
scout pass first to learn the natural displacement magnitude, then run
the constrained pass with that distance. Doubles latency per request,
~10 s extra at our current denoising step count. The user opted to
ship the cheap version and revisit.

**Pickup notes for next session:**

- **Implementation outline:** in `run_motion_api.py` `generate()`,
  when `req.seam_pose is not None`, run an extra
  `model([req.prompt], num_frames, NUM_DENOISING_STEPS,
  progress_bar=_passthrough)` first, read
  `out['root_positions'][0][-1, [0,2]]`, compute the displacement
  magnitude, pass that into `_build_seam_constraint` instead of the
  `seconds × 1.0` heuristic. The seam offset's *direction* still
  comes from the user's dial / seam-local direction; only the
  *distance* changes.
- **Cheaper alternative if 2× latency is too much:** scout pass at
  fewer denoising steps (e.g. 5). Quality of the scout doesn't
  matter — we only read its end-XZ magnitude. Risk: jittery scout
  runs may report a wonky distance.
- **Don't bump the heuristic to 1.5 m/s as a "cheap fix".** It moves
  the symptom (run prompts now back-walk; stroll prompts still
  back-walk) without solving it.
- **The visible artefact is asymmetric.** Overshoot-then-back is
  jarring; the inverse (model wanting *less* than our target → arms
  stretch / legs slide to span the gap) is subtler but still wrong.
  Eyes are tuned to backward stepping; foot-slide reads as
  uncanny-valley.

---

## Notes & traps not directly tied to a fix

- **Seam pose source needs `posed_joints`.** Pre-2026-05-07 clips
  don't carry it (we only added that field in this session). The UI
  filters them out; the API returns 400 if you reference one. If
  you regenerate older clips you'll get the field back.
- **The animation-loop coordinate frame is the seam's, not the new
  motion's.** The user's compass dial output is in **seam-local**
  space (forward = +Z relative to the seam pose's heading), and the
  API rotates that into world frame using the seam's heading. So
  picking "left" on the dial walks left **relative to the seam pose's
  facing direction**, not left in world space. Worth keeping in mind
  if a seam was originally extracted from a clip that was facing
  some odd direction.
- **`anchorInPlace` defaults differ between Animations preview and
  Shelter.** Animations preview defaults to off so you can see the
  authored translation. Shelter always passes
  `applyRootTranslation: false` because the wrapper Group owns world
  position; letting the motion's pelvis translation through would
  double-move agents. Don't unify these defaults.
- **Pace move/rest cycle resets on schedule slot change.** Resolver
  clears `paceFrom/To/StartedAt/Mode/RestUntil/RestRole` whenever the
  agent's state or destination room changes. If the next-session
  feature work touches schedule transitions, make sure freshly-arrived
  agents start with `paceMode=null` so the resolver picks the
  "first entry to a steady state" branch.
- **`getRole` triggers a fetch on miss; `peek` is sync-only.** The
  Shelter swap path peeks first, then falls back to getRole for
  uncached clips and re-applies on resolve. The optimistic
  `currentRole = wantedRole` happens before the fetch resolves so we
  don't spam — the assignment is what's stored, not the actual motion
  state. Keep that in mind if you add a third role transition path.

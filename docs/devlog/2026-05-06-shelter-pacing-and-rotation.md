# 2026-05-06 — shelter-pacing-and-rotation

Two gotchas while wiring intra-room pacing + heading rotation for
shelter avatars. Companion to
[2026-05-06-shelter-avatar-grounding.md](./2026-05-06-shelter-avatar-grounding.md);
both bit during the same iteration.

---

## Gotcha 1 — KimodoAnimator writes bone *world* rotations, bypassing parent transforms

**Symptom:** Rotating the wrapper Group around an avatar (`wrapper.rotation.y =
atan2(dx, dz)` so they face direction-of-travel) had **zero visible effect**.
Same for `worldRoot` rotations — characters always faced camera regardless of
stage tilt. Even though `wrapper.matrixWorld` and the bones' `matrixWorld`
both reflected the new rotation in numbers, the rendered character didn't move.

**Root cause:** `KimodoAnimator.update()` retargets motion to bones using
*world-space* quaternions. For each bone it does:

```js
bone.quaternion.copy(parent.matrixWorld_rotation_inverse).multiply(targetWorldQ)
```

That sets the bone's local rotation to *whatever cancels out the parent
chain*, so the bone's effective world rotation is exactly `targetWorldQ` —
the rotation embedded in the kimodo motion data — regardless of any rotation
applied to the wrapper or any other parent. The kimodo idle was authored facing
camera, so the bones forced themselves back to camera-facing each frame.

**Fix:** ff... commit + the new `KimodoAnimator.setExternalRef(obj)` API.
Per-frame the animator decomposes `externalRef.matrixWorld` to its rotation
quaternion and **premultiplies** it onto every bone's `targetWorldQ`. Bones
end up at `externalRef.world × motion.world`, which means parent rotations
finally show up on screen.

`avatarFactory.buildKimodo` wires `wrapper` as the external ref before the
warm-up `animator.update()` call so the very first rendered frame is correct.
Sims's existing animator path (no `setExternalRef`) is unchanged — its world-
anchored animations behave exactly as before.

**Trap for next time:**

- **The kimodo animator's "world-space retargeting" comment is not a hint —
  it's a warning.** Anything wrapping a kimodo-driven character in a rotated
  Group will silently lose the rotation unless `setExternalRef` is wired.
- **The `THREE.AnimationMixer` path (used by Sims's animated fallback avatar)
  doesn't have this problem** — its clips drive *local* quaternions, so
  parent rotations propagate naturally. Only the kimodo retarget pipeline
  forces world rotations.
- **`bone.parent.matrixWorld.decompose(...)` reads the parent's *current*
  world matrix.** That includes any wrapper rotation. The animator
  intentionally *cancels* this out by inverting it before applying
  `targetWorldQ`. The fix is to feed `targetWorldQ` itself the rotation
  we want to preserve, i.e. premultiply by `externalRef.world` so the
  cancellation puts the right thing in.
- **Diagnostic shortcut:** if rotating wrapper has no effect on a kimodo
  avatar, check that the animator was constructed with `setExternalRef`
  pointing at the wrapper. If `externalRef` is null, world rotations win.

---

## Gotcha 2 — `((h * 31) + c) | 0` looks like a hash but doesn't avalanche

**Symptom:** Pacing fired correctly (resolver picked a fresh waypoint every 3
sim minutes — confirmed via console log) but visibly the avatar took *one*
small step on placement and then stayed put. The lerp's `t` was advancing,
the wrapper's `position` was being updated each frame, the matrices were
propagating to the SkinnedMesh — but the lerp output was the same number for
the whole second cycle and every cycle after.

**Root cause:** The deterministic-waypoint helper used a textbook string hash:

```js
function hashCode(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h * 31) + s.charCodeAt(i)) | 0
  }
  return h >>> 0
}
```

Then sliced into u/v:

```js
const localU = 0.2 + ((h & 0xffff) / 0xffff) * 0.6
const localV = 0.2 + (((h >>> 16) & 0xffff) / 0xffff) * 0.6
```

For two inputs that differ only in the last character (e.g.
`":pace:4364"` vs `":pace:4365"`), the hash output differs by exactly **1**:

```
h_new = h_old × 31 + '5'.charCode
h_old = h_old_partial × 31 + '4'.charCode
```

so `h_new - h_old = '5' - '4' = 1`. Then `& 0xffff` collapses that one-bit
delta into a u/v difference of `1/0xffff × 0.6 ≈ 0.000009`. Effectively the
same point.

**Why pacing showed it dramatically:** `paceFrom = previous paceTo` and
`paceTo = pacePos(agent.id, roomId, cycle)`. Cycle 1's `paceFrom` was
`agent.pos` (set independently, meaningfully different) → cycle 1's lerp
visibly moved. From cycle 2 on, `paceFrom` and `paceTo` were both
`pacePos`-derived for adjacent cycles → near-identical points → lerp output
constant.

**Fix:** Murmur3-style avalanche finalizer appended to the hash:

```js
h ^= h >>> 16
h = Math.imul(h, 0x85ebca6b) | 0
h ^= h >>> 13
h = Math.imul(h, 0xc2b2ae35) | 0
h ^= h >>> 16
```

This diffuses each input bit across all output bits, so the one-bit input
difference turns into a uniformly random-looking output difference.
Consecutive cycles now pick wildly different waypoints; pacing hops the
avatar around the room as intended.

**Trap for next time:**

- **`((h * 31) + c) | 0` is not a hash, it's a checksum.** Adjacent inputs
  produce adjacent outputs. Fine for `Map` keys (`Map` hashes them itself),
  fatal when you slice the bottom bits and use them as game state.
- **Diagnostic shape:** if a "deterministic random" function produces values
  that look almost identical for incrementing inputs, it's not the random
  part — it's the hash. Test by feeding consecutive integers and printing
  the slice; if the output crawls linearly, you need a finalizer.
- **The classic Murmur3 finalizer is enough** (the `0x85ebca6b` /
  `0xc2b2ae35` constants above). Standard JS, no dependency, ~20 lines
  of mixed `xor` + `imul`.
- **Watch for the `& 0xffff` step** in particular — anything that masks the
  bottom bits of a poorly-mixed hash will inherit the lack of distribution.
- **Why we caught this and not earlier:** the existing
  `deterministicPos(agent.id, action, roomId)` in the same file uses the
  same hash but never increments its inputs by 1 character — `action` is
  always `'rest' / 'work' / 'social'`, very different strings. So the bug
  was latent there, only surfacing once we started feeding consecutive
  cycle indexes.

---

## Pattern across both

Both bugs came from the same shape: **a layer of math silently squashed the
input we expected to drive behaviour**.

- The kimodo animator: `parent_world × parent_world_inverse × targetWorld =
  targetWorld`, hence wrapper rotation cancels out.
- The hash: `& 0xffff` keeps only the bottom bits, which barely move for
  consecutive inputs.

Diagnostic move that paid off: print the *intermediate* values, not the
inputs or final position. The `[shelter:lerp]` log showed the same `computed`
number across cycles, which immediately pointed at start ≈ end → waypoint
generation broken, not the lerp pipeline.

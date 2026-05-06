# 2026-05-06 — shelter-avatar-grounding

**Symptom:** Spawned agents in the Shelter view's rooms variously sank
into the floor (up to the knees on kimodo-rigged characters), hovered
above it, or stood correctly — depending on which avatar tier the
factory landed on (kimodo / static Trellis / animated fallback). The
shadow disc beneath each agent (added as a debug aid) made the
mismatch visible.

**Root cause:** Three independent issues stacked:

1. **Projector returned the wrong floor Y.** `presenceProjector.projectLocal`
   computed `world.y = room.cy - room.h/2` — the *bottom* of the room
   shell. The visible floor surface is `floorT = 0.08` higher, because
   the shell's floor slab is inside the room. Avatars planted at the
   projector's Y were standing on the underside of the slab.

2. **`avatarFactory.wrap()` trusted the load-time template bbox.** That
   bbox was measured before `SkeletonUtils.clone` and before scale
   were applied. For skinned meshes the cloned root settles into a
   slightly different rest pose than the template's bbox suggested,
   so feet landed off-axis.

3. **Kimodo idle motion shifts the rig away from bind pose.** The
   static bbox (used by all three tiers) reflects the rest mesh
   position. The kimodo idle clip moves the hips up, leaving the
   visible feet floating above the bbox-min. The original Stage3D
   compensated with `KIMODO_FOOT_DROP = 0.15`, but UniRig output
   varies enough between rigs that a single empirical constant
   couldn't catch every case — under-compensate and they float;
   over-compensate (or pick the wrong "lowest bone") and they sink
   to the knees.

**Fix:** ff757c1, 0aeba30. Three coordinated changes:

- `presenceProjector.projectLocal` — `fy = -h/2 + FLOOR_T` (`FLOOR_T = 0.08`),
  matching `floorT` in `ShelterStage3D.buildShell`. World Y is now
  the top of the floor slab.
- `avatarFactory.wrap()` — re-measures `Box3.setFromObject(root)`
  *after* clone + scale + rotation, so `root.position.y = -liveBbox.min.y`
  reflects the actual cloned rest pose.
- `avatarFactory.buildKimodo` — after `wrap()` lands the bind pose,
  runs `animator.update()` once, then calls
  `SkinnedMesh.computeBoundingBox()` (which iterates skinned vertices
  through `applyBoneTransform`) and slides the rig so the *deformed*
  bbox min.y sits at the wrapper origin. Replaces the
  `KIMODO_FOOT_DROP` constant entirely.
- `buildFallback` — replaced `KimodoAnimator + mixamoMapping + kimodo
  idle` with `THREE.AnimationMixer` driving the GLB's bundled
  `HappyIdle` clip. The clip was authored for this avatar's bind
  pose, so feet stay grounded without fudge.

**Trap for next time:**

- **The shadow disc is the diagnostic.** It's added inside `wrap()` at
  wrapper-local `y = 0.005`, i.e. 5mm above the floor. If you see
  the disc clipping into the floor, the *projector* is wrong (avatar
  origin below floor surface). If you see the disc on the floor but
  feet floating or sinking, the *factory's grounding* is wrong
  (bbox/bone math). If the disc is missing, you're spawning at an
  invalid `roomId` (projection returns `null`).

- **Three layers of "where do feet go" math** — projector decides the
  *floor*, factory decides the *avatar's foot offset relative to the
  wrapper origin*, render code only sets the wrapper position. When
  agents float/sink, isolate which layer is wrong by checking the
  shadow disc first.

- **`Box3.setFromObject` does not skin.** For SkinnedMesh, that
  function uses the static geometry bbox transformed by the world
  matrix — it ignores bone deformation. Use
  `SkinnedMesh.computeBoundingBox()` (instance method, not the Box3
  static) for the deformed extents. It's expensive (per-vertex), so
  only call it once after pose setup, not per frame.

- **Skeleton bones aren't reliable as foot anchors** for auto-rigged
  outputs (UniRig's `bone_0`/`bone_1`/...). Picking the lowest bone
  by world Y can land on an IK target, hip pivot, or nothing
  meaningful. Prefer skinned-vertex math.

- **Constants that need to stay synced.** `FLOOR_T = 0.08` lives in
  both `presenceProjector.projectLocal` and `ShelterStage3D.buildShell`.
  If we change the floor slab thickness in one place, change both.
  Should lift into a shared layout-constants module if it bites again.

- **Where `KIMODO_FOOT_DROP = 0.15` still appears** in `avatarFactory.js`
  is now unused on the kimodo path (deformed bbox replaces it).
  It's still defined and documented — leave it for now in case we
  add a per-rig fudge override (`mapping.metadata.footOffset`)
  somewhere later.

When we come back to tweak avatar rendering — likely while overhauling
the kimodo pipeline — the shadow disc + three-layer model above is the
mental map.

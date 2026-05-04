# End-to-end character pipeline

> Plan for a single CLI script that takes a one-line creative prompt
> and produces a fully-rigged, kimodo-animatable character in the
> kimodo /web picker. Touches every external service we've stood up
> (gemma, flux1-kontext, trellis, unirig) plus a small new GLB
> post-processing step to fix the palms-down rest pose at the rig
> level instead of the t-pose generation level.

## Why a single script

Right now each step lives in a different place — bridge endpoint,
Cloud Run service, local Docker, kimodo CLI. Iterating on the pipeline
means clicking through the woid UI, waiting, copying GLBs around, and
running registry import scripts by hand. A single command:

```bash
./scripts/generate_character.py \
  --prompt "a serene tea master in feudal Japan" \
  --mesh-backend trellis \
  --label "Tea Master"
```

…that produces:

- a registered character in the woid bridge with avatar, t-pose, and
  model.glb on disk,
- a UniRig'd rig.glb with palms-down rest pose,
- a kimodo character-registry record (`unirig_<id>.json`) so the
  character shows up in the kimodo /web picker at
  <http://localhost:5174>,

…lets us A/B prompts, mesh backends, and rig fixes in one shot. The
script is a thin orchestrator over existing endpoints + one new
GLB-edit step. No new deployments needed.

## Pipeline shape

```
prompt: "a serene tea master in feudal Japan"
  │
  │ (1) gemma-4-31b on Cloud Run via /v1/personas/generate
  ▼
{ name: "Hideki Tanaka", about: "..." }
  │
  │ (2) POST /characters → mints pubkey, writes manifest
  ▼
character (pubkey, name, about)
  │
  │ (3) POST /characters/:pubkey/generate-avatar
  │     (NIM flux.1-schnell — text-to-image)
  ▼
avatar.jpeg (1024×1024 portrait)
  │
  │ (4) POST /characters/:pubkey/generate-tpose/stream
  │     (self-hosted flux1-kontext + paladin reference composite)
  ▼
tpose.png (~1024×1024 single full-body T-pose, palms-forward)
  │
  │ (5) POST /characters/:pubkey/generate-model/stream
  │     (self-hosted trellis OR hunyuan3d)
  ▼
model.glb (untextured/textured 3D mesh, no rig)
  │
  │ (6) POST localhost:8081/rig    (local-Docker UniRig)
  ▼
rig.glb (skeleton + skin weights, palms-forward rest)
  │
  │ (7) Wrist-rotate post-process (NEW STEP — ~50 lines bpy script)
  ▼
rig_palmsdown.glb (palms-DOWN rest, ready for kimodo motion)
  │
  │ (8) python web/scripts/import_unirig_glb.py
  ▼
.kimodo-characters/unirig_<id>.json + web/public/models/unirig_<id>.glb
  │
  ▼
visible in kimodo /web at localhost:5174
```

## The new step: wrist rotation at the rig level (step 7)

The crux: instead of fighting Kontext's diffusion prior to get
palms-down in the t-pose image, rotate the wrist bones in the rigged
GLB after UniRig finishes. Two reasons this is the right layer:

1. **Image-level control of palm orientation is unreliable** in current
   diffusion models (per `docs/research/tpose-generation-models.md`).
2. **Bone-level rotation is deterministic.** Once UniRig has produced
   a skeleton, we know exactly which two nodes are
   `mixamorig:LeftHand` and `mixamorig:RightHand` (or in UniRig's
   anonymous output: whatever our `unirig_mapping.py` labeler
   identified as `left_wrist` / `right_wrist` — typically `bone_9`
   and `bone_25`). A 90° local-axis rotation flips the rest pose
   from palms-forward to palms-down without touching anything else.

Implementation (Blender Python, runs against the rig.glb):

```python
import bpy, json, math, sys
from pathlib import Path

src, mapping_json, dst = sys.argv[sys.argv.index("--")+1:]
mapping = json.loads(Path(mapping_json).read_text())  # from unirig_mapping.py

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

# Find armature, switch to pose mode, rotate the two wrist bones.
arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
for side, sign in (("left_wrist", 1), ("right_wrist", -1)):
    pb = arm.pose.bones[mapping[side]]
    pb.rotation_mode = "XYZ"
    pb.rotation_euler.y = sign * math.radians(90)
bpy.ops.object.mode_set(mode="OBJECT")

# Apply current pose as the new rest pose so the bake is permanent.
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.armature_apply()  # bakes pose into rest, IBMs adjust to match
bpy.ops.object.mode_set(mode="OBJECT")

bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB")
```

Two failure modes to plan for:

- **Wrong rotation axis**: which local axis to rotate around depends
  on the rig's bone roll. We've seen Mixamo rigs that pronate on
  local Y (good) and others on local X. The script will need a
  one-time visual check to confirm; provide a `--rotation-axis y|x`
  flag that defaults to Y.
- **Sign per side**: the mirror plane means the right hand needs the
  opposite sign of the left. Already accounted for above.

This is the same pose-bake trick the kimodo team uses in
`build_blender_studio_rigid_glbs.py` — apply pose to rest, IBMs adjust
so the visual result is unchanged but the new "neutral" position is
the corrected one.

## Script layout

```
scripts/
├── generate_character.py        ← the orchestrator (this plan)
├── lib/
│   ├── bridge_client.py         ← thin wrapper over woid bridge HTTP
│   ├── unirig_client.py         ← POST localhost:8081/rig
│   ├── kimodo_import.py         ← shells out to import_unirig_glb.py
│   └── glb_palms_down.py        ← step 7 (Blender-Python sub-process)
└── examples/
    └── tea_master.json          ← saved prompt + outputs for regression
```

## CLI surface

```
generate_character.py
  --prompt TEXT                  # creative seed for persona generation
  [--seed-name TEXT]             # skip persona; use this name+about pair
  [--seed-about TEXT]
  [--mesh-backend trellis|hunyuan3d]   # default: trellis
  [--rotation-axis y|x]          # wrist rotation axis (default y)
  [--rotation-degrees N]         # default: 90
  [--skip-rig]                   # stop after model.glb (no UniRig)
  [--skip-palms-fix]             # ship palms-forward rig (debug)
  [--skip-kimodo-import]         # don't register in kimodo /web
  [--label TEXT]                 # label for the kimodo registry entry
  [--bridge-url URL]             # default: http://localhost:13457
  [--unirig-url URL]             # default: http://localhost:8081
  [--output-dir PATH]            # default: ./character_<short_id>/
  [-v|--verbose]                 # stream SSE events to stdout
```

The script is **idempotent per pubkey** — re-running with the same
seed-name/about reuses the existing character; explicit
`--regenerate-{avatar,tpose,model,rig}` flags force a fresh stage.

## Step-by-step implementation notes

### (1) Persona via gemma-4-31b

Existing endpoint: `POST /v1/personas/generate` on the bridge — already
calls Cloud Run gemma. Body is `{ seed: <prompt>, model: "<id>" }`,
response is `{ name, about, model, ... }`. Apply the existing
`apiQuota` middleware so this counts toward our budget. Persona log
already records the call, so we get debugging for free.

### (2) Character creation

`POST /characters` with `{ name, about }` mints a Nostr keypair and
writes the manifest to disk. Returns `{ pubkey, npub, ... }`. This is
how the woid UI does it.

### (3) Avatar via flux.1-schnell NIM

`POST /characters/:pubkey/generate-avatar`. Existing path — calls
Cloud Run NIM, uses the standard "Stylized portrait illustration of
<name> — <about>" prompt with retry-on-blank-output. Synchronous
response; ~10–20 s warm.

### (4) T-pose via flux1-kontext + composite

`POST /characters/:pubkey/generate-tpose/stream`. Existing SSE
endpoint, uses the side-by-side composite (avatar + paladin reference)
+ "single figure T-pose" prompt. Script consumes the SSE stream and
prints stage events. ~30 s warm, 3–6 min cold.

Output: palms-forward T-pose. We accept this; step 7 fixes it.

### (5) 3D mesh via trellis OR hunyuan3d

`POST /characters/:pubkey/generate-model/stream` is currently wired to
trellis. Hunyuan3d is now deployed and documented at
`google-cloud/gemma-4-self-hosted/hunyuan3d/API.md` (URL:
`https://hunyuan3d-h5hjqgw4rq-ez.a.run.app`). We add it to the bridge
as a backend selector rather than a parallel route — same SSE flow,
different upstream call.

**Bridge change (one new env + one switch):**

```
HUNYUAN3D_URL=https://hunyuan3d-h5hjqgw4rq-ez.a.run.app    # docker-compose env
TRELLIS_URL=https://...                                    # already there

POST /characters/:pubkey/generate-model/stream
     body: { backend?: "trellis" | "hunyuan3d" }           # default: trellis
```

The two upstreams are NOT request-compatible — handle the difference
in a small `callMeshBackend()` helper:

| | Trellis | Hunyuan3d |
|---|---|---|
| Path | `/v1/infer` | `/generate` |
| Image field | `image: "data:image/png;base64,..."` (data URI) | `image: "<bare base64>"` (no prefix) |
| Knobs | `seed`, `output_format`, etc. | `seed`, `octree_resolution`, `num_inference_steps`, `guidance_scale`, `texture`, `face_count` |
| Response | `{ artifacts: [{ base64 }] }` (JSON) | binary GLB body directly |
| Health probe | `/v1/health/ready` (NIM) | none documented — fall back to TCP-level probe |
| Cold start | 5–10 min (Cloud Run scale-to-zero with weights download) | ~90–150 s (weights baked into image) |
| Warm latency (textured) | ~20–30 s | ~50–90 s |

The SSE stage emit logic (probing → cold-start poll → generating →
done) stays identical; only the call shape differs. The script's
`--mesh-backend hunyuan3d` flag passes through to the bridge as
`body.backend = "hunyuan3d"`.

**Default sensible knobs for hunyuan3d** (per the API doc's tuning
table — "Default" row):

```
{ texture: true, octree_resolution: 256, num_inference_steps: 5 }
```

This gives a textured mesh in ~50–90 s, suitable for UniRig.

**When to pick which backend** (per the API doc's comparison + our
own usage):

- **Trellis** — faster, cleaner topology, better for rigging. Default
  for the e2e pipeline since UniRig prefers manifold input.
- **Hunyuan3d** — stronger textures, faithful to the input image
  surface details. Good when the character's *appearance* matters
  more than rig quality (or when we want to A/B character look).

Both produce static textured meshes with no rig — UniRig handles that
either way.

**Hunyuan3d caveats to handle:**

- Upstream's catch-all error returns HTTP 404 with body
  `{"text": "...NETWORK ERROR...", "error_code": 1}` for *any*
  internal failure (CUDA OOM, etc.). The bridge's error parser
  needs to read `error_code` and surface "hunyuan3d internal
  failure — check Cloud Run logs" rather than treating it as a
  routing 404.
- Background-remover always runs upstream — our t-pose images
  already have an off-white bg, which RMBG-1.4 will treat as
  background. Should be fine; flag as a thing to verify on first
  e2e run.

### (6) UniRig

The local-Docker unirig container at `http://localhost:8081/rig`.
Multipart POST with `file=<model.glb>`, returns rigged GLB bytes.
~30–60 s warm. The container must be running (`./run.sh` in
`google-cloud/gemma-4-self-hosted/unirig/`).

### (7) Wrist rotation (the new bit)

Detailed above. Inputs: `rig.glb` from step 6 and the joint mapping
from `unirig_mapping.py` (run inline against the rig.glb so we don't
re-derive). Output: `rig_palmsdown.glb`.

Validation: after the rotation, run `unirig_mapping.py` again on the
output to confirm the skeleton topology is unchanged — the mapping
should produce the exact same `bone_N → kimodo joint` table. If any
joint moved in the topology graph, the bake broke something and we
should fail loudly.

### (8) Kimodo registry import

Shell out to `python kimodo/web/scripts/import_unirig_glb.py
<rig_palmsdown.glb> --id unirig_<short_id> --label "<label>"`. Already
copies the GLB into `kimodo/web/public/models/` and writes the
registry JSON. The kimodo /web frontend bootstraps from the registry
on next page load.

The script prints the final URL:
`http://localhost:5174` and the character id to pick from the dropdown.

## Failure modes & retries

Each step has its own failure profile; the script handles them with
targeted retry policies:

| Step | Common failures | Strategy |
|---|---|---|
| 1 persona | gemma returns malformed JSON | bridge already retries 3x |
| 3 avatar | safety-block (~6 KB output) | bridge retries 3x with new seed |
| 4 t-pose | safety-block; cold start | bridge SSE retries 3x; ~10 min cold budget |
| 5 mesh | trellis cold start (5–10 min) | bridge handles, just wait |
| 6 rig | unirig container down | fail fast — operator runs `./run.sh` |
| 7 palms | wrong rotation axis | flag-controlled, manual one-time tune |
| 8 import | kimodo dir permissions | already handled (we hit this earlier) |

If step 6 fails because the unirig container is offline, the script
should **say so plainly** with the exact `./run.sh` command to bring
it up — don't auto-launch (Docker auto-starts in dev are surprising).

## What we DON'T do in this script

- **No animation playback automation.** We stop at "character is
  visible in kimodo picker." Selecting the character and hitting
  Generate motion is a human-in-the-loop step; the script's job ends
  at the registry write.
- **No woid Stage3D injection.** The kimodo registry is the
  destination, not the woid game stage. Stage3D already pulls from
  the bridge's per-character `rig.glb` (we wired that earlier), so
  if we want the same character to show up on the woid phone screen
  too, that's a separate concern handled by the existing pi-bridge
  GET endpoints — no script change needed.
- **No on-the-fly model swapping.** Trellis vs hunyuan3d is a CLI
  flag; we don't try to merge or vote between them.

## Open questions to decide before writing code

1. **Where does the script live?** Options:
   - `woid/scripts/generate_character.py` — closest to the bridge
     code it talks to most.
   - `kimodo/web/scripts/generate_character.py` — closest to the
     kimodo import target.
   - Cross-repo neutral location.
   I lean (a) — the bridge is the orchestration target and woid is
   the project we iterate on most.
2. **Sync or async?** Kimodo motion generation is async-first
   (Cloud Run cold starts). The script should be sync top-to-bottom
   — operator runs it and watches stages print. Total wall-clock
   warm-path: ~3 min. Cold-path with all services scaled to zero:
   ~15 min.
3. **Persistence of intermediates.** Each stage's output should land
   in `--output-dir/{avatar,tpose,model,rig,rig_palmsdown}.{ext}` so
   we can resume failed runs and inspect intermediate artifacts. The
   bridge already persists most of these on its workspace volume;
   the script copies them out for portability.
4. **CLI vs. notebook.** A Jupyter notebook would let us iterate on
   the wrist-rotation tuning interactively. CLI is the
   reproducibility target. Compromise: CLI is canonical, with a
   small notebook in `scripts/explore/` that calls the same lib
   functions for one-off tuning.
5. **Hunyuan3d wiring.** Deployed and documented (URL +
   request/response shape in `hunyuan3d/API.md`). Needs the bridge's
   `/generate-model/stream` endpoint to gain a `backend` selector
   (see step 5 above) before `--mesh-backend hunyuan3d` works on the
   CLI. Small bridge change — fold into the e2e build instead of
   deferring.
6. **Trellis vs hunyuan3d as e2e default.** Two reasonable choices:
   - Trellis as default → cleaner rig output, faster (also already
     wired). Pick this if "ships clean to UniRig" is the priority.
   - Hunyuan3d as default → better textures, more faithful to the
     T-pose input. Pick this if "character looks like the prompt"
     is the priority and UniRig handles the messier topology fine.
   I lean **trellis as default** for the e2e script because UniRig
   is what's downstream and topology cleanliness affects rig
   quality; hunyuan3d sits behind `--mesh-backend hunyuan3d` for
   the appearance-leaning runs.

## Build order

1. Bridge: add `body.backend` selector to
   `/generate-model/stream` + `HUNYUAN3D_URL` env + the request /
   response shape difference (data-URI vs bare base64; JSON vs
   binary). One small PR.
2. Skeleton script with stage stubs that print and call existing +
   new bridge endpoints. Validate end-to-end works for steps 1–6
   (palms-forward rig in kimodo) on both `--mesh-backend trellis`
   and `--mesh-backend hunyuan3d`.
3. Add step 7 (wrist rotation). Validate by playing a kimodo motion
   on the rigged character — palms should be down through the
   animation. Iterate on rotation axis/sign if not.
4. Add resume-on-failure (intermediate artifact persistence + skip
   stages that already have valid outputs on disk).

Total estimated time: ~1 day of focused work, ~half a day of which
is the bridge backend-selector change.

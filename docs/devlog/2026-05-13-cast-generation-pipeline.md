# 2026-05-13 — cast generation pipeline

Built a five-step reusable pipeline for spinning up demo casts: persona
→ avatar → tpose → mesh → rig+kimodo. Each step is an independent
script under `scripts/` with `--source=cloud|local`, `--manifest`,
`--limit`, `--name`, and `--force` flags so a step can be smoke-tested
on one character before running the batch, and so the cloud and local
paths stay symmetric.

The pipeline produced 16 cast members end-to-end (~16 personas, 16
avatars, 16 tposes, 16 meshes, 16 rigs) on the bridge, ready for the
demo to draw from once `added: true` is set.

---

## The pipeline

| Step | Script | Cloud | Local |
|------|--------|-------|-------|
| 1 | `generate-personas.mjs` | NIM llama-3.1-70b / qwen3-next-80b / glm-5.1 | local Gemma at `localhost:18080` |
| 2 | `generate-avatars.mjs`  | NIM flux.1-schnell → flux.1-dev → flux.2-klein-4b (safety fallback ladder) | comfy `client.py schnell` |
| 3 | `generate-tposes.mjs`   | bridge `/generate-tpose/stream` (composite + flux-kontext Cloud Run) | comfy `client.py kontext` + local PIL composite |
| 4 | `generate-meshes.mjs`   | bridge `/generate-model/stream` (TRELLIS Cloud Run) | comfy `client.py trellis[-tex][-lowpoly]` |
| 5 | `generate-rigs.mjs`     | bridge `/generate-rig/stream` (UniRig + kimodo) | — (no local path) |

A single manifest at `e2e-runs/cast-manifest.json` carries the batch
through all steps; every script skips chars already past its own stage
unless `--force` is passed.

---

## Gotcha 1 — only 3 NIM image models are actually hosted

**Symptom:** First attempt at avatar generation against NIM tried
`qwen/qwen-image`, `stabilityai/stable-diffusion-3.5-large`,
`qwen/qwen-image-edit`, `black-forest-labs/flux_1-kontext-dev` — all
404'd on `ai.api.nvidia.com/v1/genai/<model>`.

**Root cause:** Those four models' build.nvidia.com pages are
**self-hosted only** — they ship as NIM containers with `invoke_url=
http://localhost:8000/v1/infer`, with no hosted API key endpoint. Only
flux.1-schnell, flux.1-dev, and flux.2-klein-4b have hosted variants
right now.

**Fix:** `generate-avatars.mjs` cycles through those three only. When
flux.1-schnell trips the safety filter (returns a ~6KB blank PNG)
the script climbs the ladder rather than blowing up.

**How we found out:** The page reachability checks via WebFetch kept
timing out on build.nvidia.com. Switched to the `agent-browser` skill
which loads the page in a headless browser, accepts the cookie/AI
disclaimers, and lets us grep the rendered DOM for the actual
`invoke_url`. Anyone investigating future NIM models should reach for
agent-browser first, not WebFetch.

---

## Gotcha 2 — NIM safety filter returns a fixed 6213-byte PNG, not an HTTP error

**Symptom:** Avatar generation appeared to succeed (200 OK, image bytes
in the response) but the resulting PNG was a blank near-white frame.

**Root cause:** Hosted flux models return the safety-blocked frame
as a real 6213-byte PNG with HTTP 200. There is no explicit "blocked"
flag in the response.

**Fix:** `generateAvatarBytesCloud` treats anything under 15,000 bytes
as a block and either retries the same model or falls through to the
next model in the ladder. We confirmed real outputs are 100–300 KB.

The corollary: bios with words like "surveillance", "chevrons",
"uniform", "Peter Pan collar" reliably trip the filter on all three
models. The lever is to soften the bio (PATCH `about`) and retry,
not to fight the filter.

---

## Gotcha 3 — Gemma duplicates names if you give it example names in the prompt

**Symptom:** First persona batch generated "Bertram Hess × 5, Lillian
Hwang × 4" out of 16 attempts.

**Root cause:** The original `PERSONA_SYSTEM` prompt in
`agent-sandbox/pi-bridge/server.js` included specific example names
("Pearl Harrigan", etc.) as a style anchor. Gemma 4 latched onto those
as a canonical name list and regurgitated them with light variation.

**Fix:** Replaced specific example names with a *naming-style*
description, and added an explicit `CRITICAL: do NOT reuse a name
across generations` instruction. `generate-personas.mjs` also tracks
used first+last names per batch and feeds them back into the prompt
as an `avoidLine` (max 4 retry attempts per slot).

NIM models (llama-3.1-70b, glm-5.1) were noticeably better at uniqueness
than local Gemma even without the retry loop, so the script defaults
to `--source=nim`.

A related fix: every "about" used to open `"A 52-year-old…"` because
the prompt had a single age-led example. The new prompt has five
varied opening structures and an explicit `VARY THE OPENING` line.

---

## Gotcha 4 — bridge PATCH /characters whitelist doesn't accept `tposeUrl` (or `modelUrl`)

**Symptom:** Local tpose script wrote `tpose.png` to the bridge volume
successfully, then `PATCH /characters/:pubkey { tposeUrl }` returned
400.

**Root cause:** The PATCH handler at `server.js:6024` destructures a
fixed whitelist of fields. `tposeUrl` and `modelUrl` aren't on it —
they're *derived* at read time from disk by GET `/characters/:pubkey`.
Writing the file is enough; no PATCH needed.

**Fix:** Dropped the PATCH calls from both `generate-tposes.mjs` and
`generate-meshes.mjs`. Local-mode is now: write the bytes to
`/workspace/characters/<npub>/<file>` via `docker compose exec -T
pi-bridge sh -c 'cat > …'` and stop.

This is also a useful trap to remember for anyone adding new fields:
if it's derived from disk, it goes in the GET response shaper, not
the PATCH whitelist.

---

## Gotcha 5 — comfy kontext doesn't preserve the side-by-side input layout

**Symptom:** First local tpose came out cropped vertically — only the
right half of Eulalia's body was visible.

**Root cause:** The bridge's cloud tpose flow uses NIM flux-kontext
with `aspect_ratio: "4:3"`, which redraws a *single* full-canvas
figure (the side-by-side composite is anatomy guidance, nothing
more). The bridge defines `cropRightHalf` but never calls it; the
output is already a centered single figure.

I assumed comfy kontext would behave like the older NIM kontext I'd
read about — preserve the input dimensions, redraw only the right
half — and so the script cropped right. Comfy kontext actually
matches NIM's hosted kontext: full-canvas single figure.

**Fix:** Drop the crop in the local path; use the full kontext output.
The `tpose-composite.py crop-right` subcommand is still present for
future use but `generate-tposes.mjs` no longer calls it.

---

## Gotcha 6 — hosted TRELLIS NIM only accepts 4 predefined images

**Symptom:** Wanted a hosted cloud path for mesh gen (same shape as
the flux models). The TRELLIS API reference at
`https://ai.api.nvidia.com/v1/genai/microsoft/trellis` lists the
right endpoint, but the request schema says:

> `image` should be in form of `data:image/png;example_id,{example_id}`
> with `example_id` in a range `[0,3]`.

**Root cause:** It's a *Preview API* limited to four demo images, not
a general image-to-3D inference endpoint. There is no way to send our
tpose bytes.

**Fix:** Cloud path goes through the bridge's existing TRELLIS
Cloud Run service (the same one `/generate-model/stream` already uses
for /shelter/rooms generation). That endpoint accepts real arbitrary
input via `data:image/png;base64,…`. The trade-off is that the bridge's
Cloud Run instance is shared and serialized — concurrent calls queue.

For local lowpoly + textured output we use comfy's
`trellis-mesh-with-texturing-lowpoly.json` (see Gotcha 8).

---

## Gotcha 7 — Bridge's TRELLIS Cloud Run defaults to high-poly textured (no knob)

**Symptom:** Cloud-path meshes came back as ~1.5 MB GLBs (textured,
moderate poly count). Local-path mesh-only came back as ~8.5 MB
(500K faces, untextured). Local-path lowpoly textured came back as
~6 MB (10K faces, textured).

**Root cause:** The bridge `/generate-model/stream` body only forwards
`{image, seed, output_format}` to the Cloud Run TRELLIS service. There
is no `target_face_num` or `no_texture` parameter exposed. Whatever
the upstream service was deployed with is what you get.

**Improvement:** Add a `{faceTarget, noTexture}` body shape to
`/generate-model/stream` and forward to the TRELLIS service. Until
then, mixing cloud and local meshes in one cast yields visually
inconsistent results.

---

## Gotcha 8 — `target_face_num` lives in a `PrimitiveInt` node, not a backend flag

**Symptom:** Asked TRELLIS for "low poly". There's no `--lowpoly` flag
on `client.py`.

**Root cause:** The comfy workflow exports
`workflows/trellis-mesh-*.json` as raw graph JSON. Node `209` is a
`PrimitiveInt` literal feeding both `Trellis2SimplifyMesh` nodes.
Changing the value at node 209 changes the simplification target.
Original value was 500000 (film quality).

**Fix:** Forked each workflow into a `*-lowpoly.json` variant with
node 209 set to 10000 (game-ready), and added `trellis-lowpoly` and
`trellis-tex-lowpoly` subcommands to
`comfyui-runpod/client.py`. `generate-meshes.mjs --lowpoly` picks
the right variant.

If anyone needs a different face target, copy the lowpoly JSON and
edit node 209 — don't expose it as a CLI flag until we have a clear
need for more than two presets.

---

## Gotcha 9 — strict serial, not parallel, on the local GPU

**Symptom:** Earlier draft of the pipeline kicked off background
promises so the next character could start while the previous one
was still meshing. The shared 24 GB local GPU OOM'd within minutes.

**Root cause:** comfy holds the schnell, kontext, *and* TRELLIS
weights in the same image. Even one step running per character is
already pushing VRAM; two concurrent runs cross the line.

**Fix:** Every script processes characters strictly serially. The
manifest design (one row per character) makes that natural — no
need for a worker pool. Cloud is a separate matter: the bridge's
TRELLIS Cloud Run is `max-instances=1, concurrency=1`, so even there
the bridge serializes via `services.withSerializedCall("trellis", …)`
internally.

---

## Gotcha 10 — bridge GET /characters/:pubkey doesn't expose `kimodo` / `rig` markers

**Symptom:** `generate-rigs.mjs`'s idempotence check (read kimodo
marker, skip if present) didn't skip already-rigged characters. Zora
got rigged twice because of this.

**Root cause:** The bridge writes `kimodo.json` to the char dir but
the GET response shaper doesn't include it. The script's
`rigStatus()` returns null → falsy → "needs rigging".

**Workaround:** It didn't actually break anything — the bridge's
same-backend rerun is a silent overwrite (idempotent at the kimodo
registry level). But it wastes ~40s per skipped char.

**Improvement:** Expose `kimodo: {backend, importedAt}` in the GET
response, then the script can skip silently. Or have the script HEAD
a `/characters/:pubkey/rig` endpoint (doesn't currently exist).

---

## Gotcha 11 — `c.model` is the LLM id, not the 3D rig URL

**Symptom:** Pressed Demo with 19 characters flagged `added: true`.
Empty stage. No errors, no warnings except "no rigged characters on
bridge — rooms will be empty".

**Root cause:** `demoMode.fetchRiggedCharacters()` filtered with
`typeof c.model === 'string' && c.model`. A leftover comment in that
file claimed `c.model` is a URL "when the rig is on disk". It is not.
`c.model` is the LLM model id (`claude-sonnet-4-6`, `gemma-4`, etc.).
None of the 19 curated demo characters had an LLM model assigned, so
all of them were filtered out.

**Fix:** Drop the `c.model` check from the filter. Trust `added` as
the single curator-controlled signal: the checkbox sits next to the
rig preview in `AgentProfile`, so flipping it on a character with no
rig would be visibly wrong to the curator. Removed the misleading
comment.

**Improvement:** Rename or remove `c.model` to make this category
error harder to repeat — or, if we want the original filter intent,
expose `c.rigged` / `c.hasRig` derived from `kimodo.json` existence
in the GET response shaper (see Gotcha 10 / Improvement 1).

---

## Improvements still to do

1. **Surface `tposeUrl` / `modelUrl` / `kimodo` on GET responses.**
   The bridge writes the files; it should advertise them. Removes
   the need for HEAD-probing in every script.
2. **Add `faceTarget` / `noTexture` to `/generate-model/stream`.**
   So cloud and local meshes can match.
3. **Bridge endpoint to read the cast manifest.** Right now the
   manifest is filesystem-local; if you run scripts on a different
   machine than the bridge, you have to scp it. A bridge `/cast`
   endpoint that lists "currently in batch" pubkeys would close this.
4. **Auto-soften bios on safety block.** Right now safety failures
   bubble up to a human ("Zora's bio mentions surveillance — try
   again"). A pass that uses a small LLM to suggest a softer phrasing
   and PATCH it before retry would close the loop. Be careful: the
   bio is the persona's identity, so soften minimally.
5. **A `--step` flag on a single orchestrator script.** Running five
   scripts in sequence works but is a chore. `generate-cast.mjs
   --steps=personas,avatars,tposes,meshes,rigs` would be a small
   convenience.
6. **Mark `added: true` automatically on a known-good cast.** Right
   now this is a manual PATCH (or AgentProfile UI checkbox). The
   demo strictly filters on `added`, so a cast that hasn't been
   curated produces an empty stage — easy to forget after a fresh
   batch.

---

## Numbers from the 16-character run

| Step | Cloud (per char) | Local (per char) | 16-char total (cloud) |
|------|------------------|------------------|----------------------|
| persona | ~3–30s (NIM, varies by model) | ~30s (local Gemma) | ~5 min |
| avatar  | ~3s (flux.1-schnell)          | ~10s (comfy schnell) | ~1 min |
| tpose   | ~13s                          | ~85s             | ~3.5 min |
| mesh    | ~22s                          | ~250s            | ~6 min |
| rig     | ~40s                          | —                | ~11 min |

End-to-end on cloud: roughly 25 minutes for 16 characters.

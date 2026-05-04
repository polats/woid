# T-pose generation: model landscape

> Research notes (2026-05) on alternatives to FLUX.1-Kontext for the
> Assets-tab T-pose flow. Captured because we hit Kontext's diffusion
> prior pinning palms-forward despite a palms-down reference image —
> wanted to know whether a different model would handle it better
> before investing in workarounds.

## What we're trying to do

Take a stylized portrait avatar (head + shoulders, ~1024×1024 illustration)
and produce a full-body T-pose reference image:

- Same character identity (face, hair, outfit, colors).
- Standard humanoid proportions (~7.5 head-heights, arm-span ≈ height).
- Arms extended horizontally at shoulder height.
- **Palms facing the floor**, knuckles toward the camera.
- Single figure, clean off-white background.

The output feeds into Trellis (image-to-3D) and then UniRig
(auto-rigging), so palm orientation matters for the eventual rest pose
of the rigged GLB.

## What's not working with Kontext

Single-pass FLUX.1-Kontext (deployed at `flux1-kontext` Cloud Run, NIM
container) gives us *almost* everything:

- ✅ Identity transfer is solid (face, hair, clothes, accessories).
- ✅ Body restructuring portrait → full-body works once we feed a
  side-by-side composite `[avatar | reference]` instead of the avatar
  alone.
- ✅ Casual-clothing transfer works once we drop "no armor" into the
  prompt.
- ❌ **Palm orientation reverts to palms-forward** regardless of:
  - explicit prompt phrasing ("palms face the floor", "back of hands
    visible from above", "Mixamo Y-Bot orientation", anti-cues like
    "NOT supinated"),
  - reference assets that genuinely have palms-down rest pose
    (paladin armor, kimodo `male_stylized` SMPL-X figure),
  - cfg_scale up to 7.0 (NIM caps at 9).

This is a general weakness of every diffusion model we surveyed, not
something specific to Kontext: training data overwhelmingly shows
arms-outstretched humans with palms-forward (anatomical neutral), so
the diffusion prior dominates the conditioning signal for hand
orientation.

## Same-tier image-edit models (would they do better?)

**Probably not for palms.** All have the same diffusion prior issue.
Listed for completeness because they're stronger on other axes.

| Model | Notes | Self-host |
|---|---|---|
| **FLUX.2 Dev** | Black Forest Labs' newer flagship; multi-reference editing (up to 8 input images per call), strongest character-consistency claims. Q8 GGUF ~32 GB, 20+ min/edit on Cloud Run-tier GPUs. | Yes — same NIM-style deploy as flux1-kontext. |
| **Qwen Image Edit 2511** | Newer than 2509. Faster (6–8 min/edit, ~21 GB Q8). Loses to Kontext on facial identity in side-by-side tests; degrades past 1 MP output. | Yes via ComfyUI. |
| **OmniGen** | Unified single-model approach — auto-detects pose/depth/subject from inputs without needing a separate ControlNet. Decent for "follow this pose, generate this character." | Yes — open source. |

Kontext sits in the same ballpark as these. Switching to any of them
trades one set of edge cases for another but won't fix the palm bias.

## Purpose-built character generators

**Closer to what we need; still bias-prone but trained specifically on
character consistency across poses.**

- **InstantCharacter** (Tencent HunYuan, 2025) — DiT/FLUX backbone,
  designed explicitly for "place this character in any pose described
  by text" with one-shot identity matching. Open source, ComfyUI
  workflow available. Best non-ControlNet alternative if we want to
  sidestep Kontext.
  - <https://github.com/jax-explorer/ComfyUI-InstantCharacter>
  - <https://www.aibase.com/news/17300>

- **Pro-Pose** (arXiv 2512.17143, late 2025) — Self-supervised
  donor-based UV reposing strategy specifically for full-body avatars
  from single images. Research code, not yet a turnkey deploy.

- **Visual Persona** (arXiv 2503.15406) — *Requires full-body input*,
  not a portrait. Doesn't fit our case.

## Pose-conditioning approach (the actual fix for palms)

**ControlNet OpenPose + IP-Adapter** on top of Stable Diffusion or
FLUX. The architectural difference that matters:

- Pure image-to-image (Kontext et al.): the input image is a soft
  guide; the diffusion prior fills in details the prompt and
  reference don't strictly nail down. Hand orientation is one of
  those "soft" details.
- Pose-conditioned: we feed an OpenPose skeleton image with hand
  bones explicitly placed palms-down. The skeleton is a *hard*
  constraint — the model draws to it pixel-by-pixel.

Pipeline:

```
                                             ┌──────────────────────┐
                                             │ T-pose OpenPose      │
                                             │ skeleton (palms-down)│
                                             └──────────┬───────────┘
                                                        │ ControlNet
┌───────────┐ IP-Adapter ┌─────────────┐                ▼
│ avatar.png├───────────▶│ FLUX/SD base│◀──── prompt: "casual outfit,
└───────────┘            │             │       full body T-pose, ..."
                         │             │
                         └──────┬──────┘
                                ▼
                          rigged-ready
                          T-pose figure
```

What you get:

- Pose adherence is **deterministic** — wherever the skeleton's hand
  bones are, the output's hands will be. Palms-down is guaranteed.
- IP-Adapter pins the avatar's face/style/colors at moderate strength.
- Standard ComfyUI workflow; well-documented.

Trade-offs vs. our current Kontext setup:

- Adds a sibling self-hosted service (ComfyUI server or custom
  FastAPI wrapper around the same components). ~10–15 GB in weights.
- ~1–2 days to stand up cleanly, mostly Dockerfile + ComfyUI workflow
  authoring.
- Once standing, it's the same NIM-style call pattern — `POST /infer`
  with multipart inputs, returns a GLB.

References:
- <https://stable-diffusion-art.com/controlnet/>
- <https://docs.comfy.org/tutorials/controlnet/pose-controlnet-2-pass>
- <https://openart.ai/workflows/lord_lethris/quick-openpose-character-concept-sheet-creator-v12/F0Cz1ZX0xU7UebTQFyPs>

## Recommendation

Three paths, ordered by lift:

1. **Two-pass Kontext (cheap)** — keep current pipeline; after the
   first pass produces the figure, feed the result back in with a
   focused *"rotate the hands so palms face the floor, back of the
   hands visible from above"* edit. Doubles latency to ~30 s warm.
   Fixes palms in maybe 70–90 % of cases per Kontext's typical
   small-edit success rate. **Try this first.**

2. **InstantCharacter sidecar (medium)** — drop in alongside Kontext
   as an A/B option. Open source, FLUX-backbone, character-consistent
   by design. Easier than ControlNet because it's a single model
   call, not a multi-component pipeline. Won't *deterministically*
   solve palms but is purpose-built for our exact "character → new
   pose" task.

3. **ControlNet OpenPose + IP-Adapter (real fix)** — stand up a
   ComfyUI sibling service in `google-cloud/gemma-4-self-hosted/`.
   Only path that gives us 100 % palm orientation control. Worth it
   if T-pose precision becomes a hard requirement for the UniRig +
   kimodo animation stage.

Don't bother with FLUX.2 / Qwen / OmniGen as straight Kontext
replacements — they're peers, not upgrades, for our specific
constraint.

## Sources

- [Flux Kontext vs Qwen Edit 2509 — pose transfer comparison](https://medium.com/@wei_mao/flux-kontext-vs-qwen-edit-2509-the-ultimate-pose-transfer-test-shocking-results-db7225b6f2bb)
- [Model Rundown: Z-Image Turbo, Qwen Image-2512/Edit-2511, Flux.2 Dev](https://medium.com/diffusion-doodles/model-rundown-z-image-turbo-qwen-image-2512-edit-2511-flux-2-dev-fc787f5e87ad)
- [FLUX.2 Image Editing — Black Forest Labs docs](https://docs.bfl.ml/flux_2/flux2_image_editing)
- [FLUX.2 Next Generation Image Generation](https://bfl.ai/models/flux-2)
- [FLUX.2 [dev] Multi-Reference Image Editor (fal.ai)](https://fal.ai/models/fal-ai/flux-2/edit)
- [InstantCharacter on GitHub (jax-explorer/ComfyUI-InstantCharacter)](https://github.com/jax-explorer/ComfyUI-InstantCharacter)
- [InstantCharacter ComfyUI Workflow — RunComfy](https://www.runcomfy.com/comfyui-workflows/instantcharacter-comfyui-workflow-flux-dit-personalization)
- [OmniGen (VectorSpaceLab) on GitHub](https://github.com/VectorSpaceLab/OmniGen)
- [OmniGen — Inpainting, ControlNet, and More](https://medium.com/@codingdudecom/omnigen-next-gen-image-generation-d4eccaf41fc6)
- [Visual Persona (arXiv 2503.15406)](https://arxiv.org/html/2503.15406v2)
- [Pro-Pose: Unpaired Full-Body Portrait Synthesis (arXiv 2512.17143)](https://arxiv.org/html/2512.17143)
- [PHiD — Preserving human identity in pose-guided animation](https://www.sciencedirect.com/science/article/abs/pii/S0925231225015577)
- [MagicPose — Pose & Expression Retargeting (arXiv 2311.12052)](https://arxiv.org/html/2311.12052v3)
- [Identity-Preserving Pose-Guided Character Animation (arXiv 2412.08976)](https://arxiv.org/html/2412.08976v2)
- [Quick OpenPose Character Concept Sheet Creator (ComfyUI)](https://openart.ai/workflows/lord_lethris/quick-openpose-character-concept-sheet-creator-v12/F0Cz1ZX0xU7UebTQFyPs)
- [Master Character Poses with Flux Pose Control](https://pixeldojo.ai/flux-character-pose-control)
- [Tencent HunYuan Open-Sources InstantCharacter](https://www.aibase.com/news/17300)
- [ControlNet — Stable Diffusion Art](https://stable-diffusion-art.com/controlnet/)
- [ComfyUI Pose ControlNet 2-pass tutorial](https://docs.comfy.org/tutorials/controlnet/pose-controlnet-2-pass)

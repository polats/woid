---
name: Asset services — local ComfyUI option
description: Add a self-hosted ComfyUI backend alongside the existing FLUX.1-Kontext / Hunyuan3D Cloud Run services so persona asset generation (T-pose, image posts) can run locally for free during dev and as a fallback when cloud quotas are exhausted.
status: todo
order: 435
epic: asset-pipeline
related: [42d6c5f1]
---

The Persona Assets tab currently calls a self-hosted FLUX.1-Kontext service on Cloud Run for T-pose generation, and Hunyuan3D on Cloud Run for mesh. Both have cold-start budgets (18m / 30m) and per-call cost. For local dev and as a hedge against cloud outages, we want a ComfyUI option that runs on a workstation GPU.

## Slices

### Slice 1 — ComfyUI runtime

- Pick a ComfyUI deployment shape (Docker image vs native install). Document GPU requirements (VRAM for FLUX.1-Kontext + SDXL fallback).
- Workflow JSONs checked into `services/comfyui/workflows/`:
  - `tpose.json` — FLUX.1-Kontext T-pose generation matching the current Cloud Run prompt contract.
  - `image-post.json` — character image post (matches the kind:1 `image_url` pipeline used in #355).
- A thin HTTP shim (`services/comfyui/server.py`) that exposes the same endpoint shape as the existing FLUX service: `POST /generate { prompt, ref_image_url } → { image_url }`. ComfyUI's native API is graph-based; the shim translates a flat request into a workflow run and polls until the output node finishes.

### Slice 2 — Bridge wiring

- `bridge` config: `ASSET_BACKEND=comfyui|cloudrun` (per-service: `TPOSE_BACKEND`, `IMAGE_POST_BACKEND`).
- Service status page shows which backend is active and the queue depth for ComfyUI (it has its own queue endpoint).
- Per-service inference mutex (already in place for cloud, ecdf881) extends to the local backend.

### Slice 3 — Docs

- README in `services/comfyui/` covering: model downloads, ports, how to flip the bridge env var, expected VRAM.

## Acceptance

- With `TPOSE_BACKEND=comfyui` and a local ComfyUI running, clicking "Generate T-pose" in the Persona Assets tab produces an image identical in shape to the cloud path (same upload URL, same metadata).
- Falling back to cloud requires only an env var flip + bridge restart.
- Service status page distinguishes the two backends.

## Non-goals

- Mesh (Hunyuan3D) on local ComfyUI — that's #445's territory.
- Auto-routing between local and cloud based on health.

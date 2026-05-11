---
name: Asset services — deploy UniRig and Kimodo to web
description: UniRig (auto-rigging) and Kimodo currently run only on local workstations. Package both as Cloud Run services in the same shape as Hunyuan3D / FLUX.1-Kontext so the Persona Assets tab can drive them remotely without a local GPU.
status: todo
order: 445
epic: asset-pipeline
depends_on: [435]
related: []
---

The asset pipeline already has a working Cloud Run pattern (Hunyuan3D, FLUX.1-Kontext) with per-service inference mutex and cold-start budgets tuned for long warmups. UniRig and Kimodo are the next two stages we want hosted so a contributor without a local GPU can drive the full pipeline from the Persona Assets tab.

## Slices

### Slice 1 — UniRig service

- Containerize UniRig with its model weights baked in (or pulled at first boot from GCS).
- HTTP API: `POST /rig { mesh_url } → { rigged_url, weights_url }`. Match the Hunyuan3D contract for upload/download URLs.
- Cold-start budget: start at 18m like Hunyuan3D, tune from logs.
- Per-service inference mutex on the bridge (same pattern as ecdf881).

### Slice 2 — Kimodo service

- Same shape as Slice 1. Confirm exact endpoint contract (input modality, output artifacts) before container work — Kimodo's role in the pipeline needs to be locked down.
- Note: confirm spelling ("Kimodo" vs "Komodo") and link to upstream repo in the service README.

### Slice 3 — Bridge + UI wiring

- Bridge endpoints proxy `/rig` and the Kimodo equivalent through the same auth/queue path used today.
- Persona Assets tab gains buttons for the new stages, with status pills mirroring Hunyuan3D.
- Service status pages list both new services with cold-start state and last-call latency.

## Acceptance

- From the Persona Assets tab, a user with no local GPU can: generate a T-pose → mesh → rigged mesh → Kimodo output, all via Cloud Run.
- Cold start metrics for both services are visible on the service status page.
- A failed call surfaces the same way Hunyuan3D failures do today.

## Non-goals

- Local ComfyUI integration for these stages (covered partially by #435).
- Pipeline orchestration / chaining the stages automatically — user still clicks each step.

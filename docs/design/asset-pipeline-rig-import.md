# Asset pipeline — rig + kimodo import (steps 6-8)

Plan for moving the second half of `scripts/generate_character.py`
into the bridge + frontend. Steps 1-5 (persona, avatar, T-pose,
3D model) are already wired through the bridge. This doc covers
6 (UniRig), 7 (palms-down Blender bake), and 8 (kimodo registry
import).

Companion: `scripts/generate_character.py` is the working CLI that
does all of this end-to-end on the host. Bridge endpoints below
are the same chain, just orchestrated server-side with SSE
progress events for the frontend.

## Locked-in decisions

- **Architecture A.** `kimodo-tools` is a sibling Docker service
  bundling Blender + Python + the kimodo scripts. Bridge calls it
  over HTTP, same shape as UniRig. Bridge stays language-agnostic.
- **Backend regen gate (Phase 3).** Import refuses if
  `.kimodo-characters/<id>.json` already exists for this pubkey
  *with a different backend*; frontend's "Regenerate rig" passes
  `force: true` after a confirm() to override. Same-backend regen
  silently overwrites, matching the CLI today.
- **Deferred for now:** registry-on-shared-volume (Q3) — fine for
  local dev, revisit when staging lands. Animations pipeline (Q4)
  — separate doc once rig+import lands.

## Bridge endpoint

```
POST /characters/:pubkey/generate-rig/stream
  body: { backend?: 'trellis' | 'hunyuan3d', force?: boolean }
  Server-Sent Events:
    stage:    { stage, message, etaSeconds? }
    heartbeat:{ elapsedMs }
    done:     { rigUrl, kimodoCharId, label, backend, elapsedMs, bytes }
    error:    { error, stage? }
```

Stage progression mirrors `generate_character.py`:

| stage         | what runs                                | typical |
|---------------|------------------------------------------|---------|
| `probing`     | confirm `model.glb` exists, kimodo-tools alive | ~50ms |
| `cold-start`  | (kimodo-tools wake, if needed)           | up to coldEta |
| `warm`        | kimodo-tools ready                       | — |
| `rigging`     | POST `model.glb` → `${UNIRIG_URL}/rig`   | 30-60s |
| `mapping`     | run `unirig_mapping.py` on `rig.glb`     | <2s |
| `palms-down`  | Blender bake via `glb_palms_down.py`     | 5-10s |
| `importing`   | write registry record + copy GLB         | <1s |
| `done`        | success                                  | — |

On disk per character (in `getCharDir(pubkey)`):
- `model.glb`        — already there (step 5)
- `rig.glb`          — UniRig output (step 6)
- `rig_mapping.json` — bone table (step 7a)
- `rig_palmsdown.glb`— final rigged GLB (step 7b)
- `kimodo.json`      — `{ id, label, backend, importedAt }` so the
                       bridge knows the registry record exists and
                       can short-circuit on remount.

Kimodo registry side (in `${KIMODO_DIR}/.kimodo-characters/`):
- `<id>.json` — registry record (id, label, mapping, model URL).
- `web/public/models/<id>.glb` — copy of `rig_palmsdown.glb`.

Where `id = unirig_<pubkey[:12]>_<backend>`.

## Service registry

New entry in `agent-sandbox/pi-bridge/service-registry.js`:

```js
"kimodo-tools": {
  label: "kimodo-tools",
  description: "Local rig finalisation (palms-down + registry import).",
  kind: "local",
  urlEnv: "KIMODO_TOOLS_URL",
  fallbackUrl: "http://host.docker.internal:8082",  // sibling container
  coldBudgetMs: 60_000,
  warmEtaSeconds: 5,
  coldEtaSeconds: 30,
  idleTimeoutMs: null,
}
```

Sidebar list in `Sidebar.jsx` extends to:
```js
['flux-kontext', 'trellis', 'hunyuan3d', 'unirig', 'kimodo-tools']
```

`ApiStatusPage.jsx` works as-is for `kind: 'local'` (probe = `${url}/v1/health/ready`).

## kimodo-tools container

A small FastAPI service that wraps the existing kimodo scripts:

```
POST /rig-finalize    multipart: rig.glb (UniRig output)
                      query:     pubkey, backend, label
                      → JSON: { mapping, palmsGlbBase64, kimodoCharId }
GET  /v1/health/ready → 200 ok when Blender + scripts are reachable
```

Implementation: re-uses `unirig_mapping.py` and the existing
`scripts/lib/glb_palms_down.py` from `woid/`, runs the kimodo
import script (`web/scripts/import_unirig_glb.py`) inside the
container against a bind-mounted `.kimodo-characters/`.

Bridge calls `/rig-finalize` after step 6, gets back the palms-down
GLB + mapping + the resolved kimodo id. Bridge writes the bytes to
the character dir as `rig_palmsdown.glb` and persists `kimodo.json`.

Image build: extends `python:3.11-slim`, apt-installs Blender,
copies the kimodo scripts in. Adds ~1.5 GB to the dev compose
stack — acceptable for now.

## Frontend changes

**`src/lib/rigStore.js`** (new) — copy `modelStore.js` shape:

```js
import { createSseJobStore } from './sseJobStore.js'
export const { start, cancel, getState, subscribe, isRunning } = createSseJobStore({
  pathFor: (pubkey) => `/characters/${pubkey}/generate-rig/stream`,
  resultUrlField: 'rigUrl',
})
```

**`src/AgentAssets.jsx`** — replace `AnimationsPlaceholder` with
`RigSection` (Section 03). Same shape as `ModelSection`:

- Tile chain `[3d model] → [rigged]` with the rig GLB rendered via `<GlbViewer />`.
- Buttons: `Generate rig` (calls `rigStore.start({ pubkey, bridgeUrl, body: { backend } })`).
- Disabled until model exists; backend inherited from the model's `meta.backend`.
- Done state: kimodo char id badge + a "View in kimodo" deep link.
- Section 04 becomes the new `AnimationsPlaceholder`.

**Cache-aware re-entry.** On mount, the section reads
`/characters/:pubkey` (existing endpoint) for `rigUrl` /
`kimodoCharId`. If both are set, render done-state without
retriggering. Bridge populates these when `kimodo.json` exists in
the character dir.

## Phasing

| # | Deliverable | Notes |
|---|---|---|
| 1 | **Bridge skeleton** with stubbed stages emitting realistic SSE | THIS PHASE — frontend can be built in parallel |
| 2 | **Wire UniRig stage** | Real POST to `${UNIRIG_URL}/rig`, save `rig.glb` |
| 3 | **kimodo-tools container** + palms-fix + import wiring + force gate | Architecture A; (c) regen gate |
| 4 | **Frontend Section 03** | `rigStore`, `RigSection`, GLB viewer for the rig |
| 5 | **Sidebar + status** | Add `kimodo-tools` to service registry + sidebar |
| 6 | **Cache-aware re-entry** | Bridge `/characters/:pubkey` includes `rigUrl`+`kimodoCharId` |

## Out of scope

- Animations pipeline (motion clips per character).
- Multi-backend variants per agent (decided to overwrite, not keep).
- Shared-volume kimodo registry (single dev workstation today).
- Hand-edit-protection — the regen gate triggers on backend mismatch
  only, not on hand-edits to a registry record.

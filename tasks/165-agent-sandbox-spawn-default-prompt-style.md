---
name: Drag-to-spawn picks up the user's preferred prompt style
description: New characters get `promptStyle: "dynamic"` at create time, but spawning an existing `minimal` character via drag-to-spawn keeps them on minimal. Add a global default in Settings + a one-time migration option.
status: todo
order: 165
epic: agent-sandbox
---

After the dynamic/minimal A/B (commit a1dde63), new characters spawn on `dynamic`. Existing characters and any character whose manifest already has `promptStyle: "minimal"` keep that style on every spawn — even if the user has decided dynamic is the new normal.

There's no UI surface for "all my new spawns should be dynamic" without going into each character's Profile drawer and flipping it manually.

## Deliverables

### Global default in `SandboxSettings`

- Add a "Prompt style" row alongside Brain in the existing Settings panel (`src/SandboxSettings.jsx`):
  - Options: `dynamic`, `minimal`, `(per-character)` — last leaves it to the manifest as today.
  - Persist via `useSandboxSettings` (localStorage), same as provider/model/harness.
- `Sandbox.spawnBody` priority becomes:
  1. Per-character `c.promptStyle` from manifest (explicit override wins)
  2. `settings.promptStyle` if user set a global default
  3. Server falls back to manifest field, which defaults to `"minimal"` for legacy characters
- Spawn body sends `promptStyle` when set; bridge already accepts it on `POST /agents` once the field is added there.

### `POST /agents` accepts `promptStyle` override

`createAgent` currently reads `harness` from `pubkey`-or-name + body. Mirror for `promptStyle`: spawn-time override > character.promptStyle > legacy default. Persist the chosen style on the manifest if it's an explicit override (same pattern `harness` uses).

### One-shot migration tool

`POST /admin/migrate-prompt-style { from?: 'minimal', to: 'dynamic' }` — for each character with the `from` style (or with no field at all), set `promptStyle: to` on their manifest. Returns a count. Localhost-only or admin-token gated. Useful once you've decided dynamic is the default for everyone.

## Acceptance

- Pick `dynamic` in `SandboxSettings`. Drag an existing `minimal` character onto the map. The runtime spawns with `harness === 'direct'` and `promptStyle === 'dynamic'`. The character's persisted manifest also flips to `dynamic` (so the choice sticks).
- Pick `(per-character)` — the existing flow is unchanged: legacy chars stay on minimal, new ones on dynamic.
- `POST /admin/migrate-prompt-style { to: "dynamic" }` flips every legacy minimal/missing character to dynamic in one call.

## Non-goals

- A wizard for migrating the prompt style of currently-running agents (they need to be respawned to pick up the new style; the harness's pinned system prompt only re-syncs on next-turn drift detection, but switching prompt style mid-conversation is more confusion than it's worth — user should stop + respawn).
- Bulk UI controls beyond the global default — the migration endpoint covers the "I want everyone on dynamic" case.

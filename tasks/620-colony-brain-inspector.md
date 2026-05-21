---
name: Agent inspector for Colony brains — renderer registry in the overlay
description: The Inspector tab inside <AgentSandboxOverlay /> picks a renderer based on brain type. Pi NDJSON → existing renderer. Colony UtilityBrain → new "candidates + scores + winner" renderer. Lets you compare LLM thinking and utility scoring in the same panel.
status: superseded
order: 620
epic: harness
depends_on: [550, 580, 590, 600]
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.7. See **[docs/design/world-registry.md §6](../docs/design/world-registry.md#6-sandbox-overlay-shape-590)**.

The Inspector tab is the surface where the harness's "brains are pluggable" claim becomes inspectable. Sims's pi NDJSON already has a renderer; Colony's UtilityBrain currently has none — this card lands the renderer registry + the Colony renderer + the telemetry plumbing on the loop side.

## Deliverables

### Telemetry on the Colony loop

- `src/lib/colony/loop.js`:
  - Maintain a per-dupe ring buffer of brain decisions (last 50). Each entry: `{ ts, tick, candidates: [{ verb, args, scores: { needPressure, proximity, skillMatch, stressRelief, final } }], winner, fallback?: boolean }`.
  - Expose via `loop.telemetry(dupeId) → { snapshot(): Decision[], subscribe(fn): unsubscribe }`.
  - Capture happens inside the `step()` orchestration — after `UtilityBrain.step(obs)` returns, the scorer outputs are computed alongside (the brain already has them; expose them via an extra return field or a wrapper).
- `src/lib/colony/world.js` (already implements WorldAdapter from [#580](580-colony-world-adapter.md)): `telemetry(characterId)` returns the loop's TelemetryStream.

### Brain telemetry contract

- `src/lib/harness/world-registry.js` (extend if needed):
  - `TelemetryStream` typedef: `{ kind: string, snapshot(): TelemetryEvent[], subscribe(fn: (event) => void): unsubscribe }`.
  - `TelemetryEvent = { ts, kind: 'utility-decision' | 'pi-ndjson' | string, payload: unknown }`.

### Renderer registry

- `src/components/InspectorRenderers.js`:
  - `registerRenderer(kind, RendererComponent)` / `getRenderer(kind) → Component | DefaultRenderer`.
  - Ships with two renderers:
    - `kind: 'pi-ndjson'` → existing `<AgentWaterfall />` (or equivalent component pulled from `AgentDrawer.jsx`).
    - `kind: 'utility-decision'` → new `<UtilityDecisionRenderer />`.

### Utility decision renderer

- `src/components/UtilityDecisionRenderer.jsx`:
  - Shows the most recent N (default 10) decisions as a vertical stack.
  - Each decision card: the candidates table with per-scorer columns (`needPressure | proximity | skillMatch | stressRelief | final`), the winner highlighted, the fallback flagged if used.
  - Hovering a row shows the full args.
  - Top of the panel: filter by verb (mine / eat / sleep / idle / all).

### Inspector tab

- `src/components/InspectorTab.jsx` (lives in the overlay):
  - Reads `activeWorld` and `activeInspectedCharacterId` from `useOverlayState`.
  - Calls `WorldRegistry.byId(activeWorld).telemetry(characterId)`.
  - If null → "this world doesn't expose brain telemetry yet" empty state.
  - Else → picks the renderer via `getRenderer(stream.kind)` and renders.

### Drawer migration

- The existing `AgentDrawer.jsx` opened on agent-row click in `Sandbox.jsx`. The Inspector tab supersedes it for telemetry rendering. Keep `AgentDrawer.jsx` for other purposes (profile editor, assets) — the Inspector tab is *just* the live telemetry view. Drawer + Inspector coexist; the overlay's "Inspector" tab handles brain decisions, the existing drawer's other tabs (Profile, Assets) stay in their previous form.

## Acceptance

- Open the overlay → click Roster → click a Colony dupe → Inspector tab populates with the dupe's last 10 utility decisions.
- Pick a verb filter ("mine") → only decisions where `mine` was a candidate appear.
- Switch to a Sims character → renderer switches to the pi NDJSON one; decisions render the same way they used to in `AgentDrawer.jsx`.
- Shelter character: "no telemetry available" empty state.
- Playwright spec: visit Colony, wait 4s for autonomous mining, open overlay → Inspector → assert that at least one decision card shows `mine` as the winner.

## Non-goals

- LLM brain on Colony dupes (Path A territory).
- Shelter resolver telemetry. The resolver's per-tick patches could be a TelemetryStream in a follow-up.
- Persistent telemetry across reloads. Ring buffer is in-memory.
- Replay scrubber. Just the most-recent-N for now.

## Risk notes

- **Scorer outputs require capturing during `UtilityBrain.step`.** The brain doesn't currently return scores — only the chosen actions. Two paths:
  - Add a `debug` mode to `createUtilityBrain` that returns `{ actions, decisions }`.
  - Wrap the scorers to write to a shared mutable slot during step.
  
  First is cleaner; pick that. Minor change to `UtilityBrain.js`.
- **Renderer registration timing.** The registry must be populated before any Inspector mount. Mitigation: register both built-in renderers in module init (side-effecting import).
- **Telemetry ring buffer overhead.** 50 entries × decisions per tick × 4 Hz × 4 dupes = ~800 entries/sec produced, capped at 50 per dupe. Buffer cost is negligible; render cost is bounded by N visible cards.

## Related work

- [#480 — Interfaces + UtilityBrain (done)](480-harness-interfaces.md) — the brain that gains a debug mode.
- [#500 — Colony utility AI (done)](500-colony-utility-ai.md) — the loop where telemetry is captured.
- [`src/AgentDrawer.jsx`](../src/AgentDrawer.jsx), [`src/AgentWaterfall.jsx`](../src/AgentWaterfall.jsx) — existing pi-NDJSON rendering this card reuses.

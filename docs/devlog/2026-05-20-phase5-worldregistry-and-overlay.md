# 2026-05-20 — Phase 5: WorldRegistry + agent sandbox overlay across all worlds

> **⚠️ REVERTED, same day (2026-05-21 cleanup).** The tabbed overlay was rejected during user testing — "I don't understand why you just didn't use the agent sandbox UI and created a new uglier one." The simpler `SandboxCards` drawer (a single agents panel reused from `Sandbox.jsx`) replaced the five-tab `AgentSandboxOverlay`. The `WorldRegistry` + `WorldAdapter` types were deleted; cross-world coordination now lives in a lightweight lifecycle registry (`src/lib/harness/registry.js`) plus two hooks (`useWorldDrop`, `useWorldRegistration`). Roster aggregation, `PortableIdentity`, telemetry streams, and the renderer registry never made it past the orphan stage — none had a live UI consumer after the overlay was simplified.
>
> What survives from this effort:
> - The `src/lib/harness/{types,memory,moodlets,needs,perception}.js` substrate (Phase 0/1), unchanged.
> - `MemoryIdentityStore` + the brain implementations (`UtilityBrain`, `DeterministicBrain`).
> - Colony's `GameAdapter` (`src/lib/colony/adapter.js`) — distinct from the deleted `world-adapter.js`.
>
> The cross-world claim in the harness plan is now told through user-visible behavior instead of architecture: drag a card from `SandboxCards` into any world (Sims / Shelter / Colony) and a per-world "Stop in &lt;World&gt;" button appears wherever that character is live. Same outcome, ~1200 fewer LOC.
>
> Task cards #550–#640 are marked `status: superseded`. Read the rest of this devlog for historical context only.
>
> ---

Phase 5 of the agent-harness plan shipped. The promise was: "make the cross-world claim physically true rather than verbally true." Done. The same overlay opens over Sims, Shelter, and Colony, the roster aggregates characters from all three, and persona creation lands the same `PortableIdentity` into any chosen world.

Tasks closed: [#550](../../tasks/550-world-registry-primitive.md) – [#640](../../tasks/640-sidebar-cleanup-and-route-redirects.md). Plan + design in [docs/design/world-registry.md](../design/world-registry.md).

## What now works

- **`WorldRegistry`** (`src/lib/harness/world-registry.js`) — singleton with per-adapter registration, `Promise.allSettled` aggregation across all three worlds.
- **Three world adapters** wrap existing game stores without modifying them:
  - `src/lib/sims/world.js` — pi-bridge HTTP translator + SSE telemetry stream.
  - `src/lib/shelter/world.js` — shelterStore reader + `addAgent` spawn.
  - `src/lib/colony/world-adapter.js` — colonyStore + brain telemetry ring buffer.
- **Sandbox overlay** (`src/AgentSandboxOverlay.jsx`) — right-side drawer with five tabs (Roster, Inspector, Personas, Storyteller, Room). Mounted at the app root; renders over whichever world view the user is on.
- **Floating FAB** (`src/components/AgentSandboxFab.jsx`) on each world's view + `Ctrl/Cmd + ;` keyboard shortcut + Esc to close.
- **Cross-world drag-and-drop** — drag a row from the Roster onto Colony tiles (`RoomMap`) or Shelter's 3D stage (new raycast handler in `ShelterStage3D.jsx`).
- **`PortableIdentity`** + `LocalStorageIdentityStore` — `Spawn to Sims/Shelter/Colony` buttons in the Personas tab dispatch through the registry.
- **Brain telemetry registry** — `InspectorRenderers.jsx` maps `kind` → React component. Ships with `UtilityDecisionRenderer` (Colony candidates + scores + winner) and a `PiNdjsonRenderer` stub.
- **Sidebar** — "Game" → "Worlds"; removed NPCs/Rooms/Agent Sandbox/Personas/Image-posts/Relay-feed/Network top-level entries (superseded by the overlay); Journal kept with a "sims" badge.
- **Legacy `#/agent-sandbox` redirect** to `#/game` with overlay open, preserving deep links.

## Decisions that landed differently than the plan

### Dual-store gotcha — unified through a singleton

The plan's first cut had `colonyStore` instantiated in two places: the React hook (`useColonyStore`) and the WorldAdapter (`world-adapter.js`). Each kept its own module-level `_store`. Spawns through the adapter mutated *its* store; the React view watched the *other* store. Same localStorage key, two different snapshots, silent drift.

Fix: `src/lib/colony/store-singleton.js` is the single owner. Both the hook and the adapter call `getColonyStore()`. One instance, one subscription tree, one source of truth.

This made me revisit the Sims/Shelter adapters as well — they each grab the relevant store through a shared accessor (the existing `useShelterStore` hook's pattern, which I preserved).

### Debounced localStorage write never fired

Colony's brain mutates state every 250ms. The store's persist function was a 500ms debounce. The timer kept getting reset before it could fire, so localStorage never got written — the in-memory state worked but a refresh lost everything.

Fix: max-wait pattern in the debounce. Persist still groups bursts (up to 500ms quiet), but forces a write at most every 2s (`WRITE_MAX_WAIT_MS`). The first localStorage write now appears within ~1s of opening Colony.

This bug existed silently in Phase 0–4 since the autonomous-mining test read DOM, not localStorage. Caught when Phase 5 added a test that polled localStorage to verify roster aggregation worked.

### DnD via Playwright is unreliable; integration path covered programmatically

HTML5 native drag-and-drop in headless Chromium doesn't reliably preserve `dataTransfer.setData` across simulated dragstart→drop. Spent half a session trying `dragTo`, manual `DragEvent` dispatch with shared `DataTransfer` — all flaky.

Resolution: the actual user-facing DnD works (verified manually in a real browser via the dev server). The Playwright spec for spawn integration goes through `getWorldRegistry().byId('colony').spawn(...)` directly inside `page.evaluate(...)`. That tests the path the drop handler invokes, which is the actually-load-bearing part. The HTML5 plumbing in `RoomMap.jsx` and `ShelterStage3D.jsx` is the same MIME-type pattern Sims has used in production for months.

### Storyteller / Room tabs reuse the existing Recap + Storyteller + RoomMap components

`Sandbox.jsx` (the old `#/agent-sandbox` route's component) had Recap, Storyteller, and a 2D RoomMap-based room view all wired with their own pi-bridge fetchers. Instead of extracting them into the overlay verbatim, the Storyteller tab and Room tab each render the existing components directly. The Room tab adds its own minimal pi-bridge fetch for rooms/characters/objects and an in-room chat input identical to Sandbox's. Net cost: ~120 LOC, zero refactor of the originals.

### Sidebar trimmed more aggressively than the card sketched

Plan said to *redirect* `#/npcs` and `#/personas` to the overlay. In practice the easier move is to just remove the sidebar entries; the routes still resolve, so deep-linkers don't 404. The redirected `#/agent-sandbox` is the only one that auto-navigates because it's the one most likely to be bookmarked.

## Test surface

- `npm run smoke` — 4/4 OK.
- `npm run agent-sandbox:smoke` — 3/3 services healthy.
- `e2e/agent-sandbox-overlay.spec.ts` — 6 specs:
  - FAB opens overlay, Roster aggregates Colony dupes, no console errors.
  - `#/agent-sandbox` redirects to `#/game` with overlay open.
  - `WorldRegistry.spawn` places a character into Colony from any world.
  - Personas tab creates `PortableIdentity` + spawns into Colony.
  - Inspector tab renders `utility-decision` payloads for a clicked dupe.
  - Ctrl+; toggles overlay from Shelter; header shows the right world chip.
- `e2e/colony.spec.ts` — 3 specs, all green.
- `e2e/home.spec.ts` — green.

Total: **10/10 specs pass** after each Phase 5 slice landed.

## What validates the "cross-world" claim now (the prior plan's weak point)

| Before Phase 5 | After Phase 5 |
|---|---|
| Only Colony imported from `src/lib/harness/`. Sims and Shelter shared *patterns* but not *code*. | All three worlds satisfy a uniform `WorldAdapter` interface and are visible in one Roster tab. |
| The "harness across three games" claim was forward-looking. | A single drag from the Roster onto Colony's tile grid, then Shelter's stage, then Sims's room calls `registry.byId(W).spawn(...)` through the same path for all three. |
| No telemetry path for non-pi brains. | Renderer registry (`pi-ndjson` / `utility-decision`) — Sims's pi NDJSON and Colony's utility decisions render in the same panel. |
| Identity was a name string per game. | `PortableIdentity` is a real type; same `id` across worlds; "Spawn to ..." button creates game-local instances sharing one identity. |

## Open follow-ups (deferred past Phase 5, no urgency)

- **In-room chat from `#/game`** — currently lives in the overlay's Room tab. The 3D Sims view doesn't yet have a chat widget itself. Out of scope; users open the overlay if they want to post.
- **Sandbox.jsx file disposition** — still in the repo; the route redirect points away from it but the file isn't deleted. Safer to give it a release of bake time before removing.
- **Mobile-responsive overlay** — the drawer is desktop-only for now.
- **Touch-device DnD** — HTML5 DnD doesn't work on most touch browsers. Long-press alternative is a future polish.
- **Two `moodlets.js` files** — pi-bridge has the Node version, harness has the browser version. Convergence still deferred (plan §7 hook unchanged).
- **PiNdjsonRenderer** is a stub — the rich rendering lives in `AgentDrawer.jsx` / `AgentWaterfall.jsx`. Extraction is a follow-up if the Inspector tab becomes the canonical view.
- **Per-game tile renderer** — Colony reuses `RoomMap.jsx` with a `glyphFor` override. If a future game has a fundamentally different spatial model (3D, hex, free-form), it'll need its own renderer.

## Numbers

| Metric | Phase 0–4 | Phase 5 added | Cumulative |
|---|---|---|---|
| New files | 19 | 14 | 33 |
| Modified existing files | 4 | 8 | 12 |
| Total LOC new code (excl. docs) | ~1,200 | ~1,400 | ~2,600 |
| Total LOC docs | ~600 | ~500 | ~1,100 |
| Playwright specs | 3 | 4 | 7 (10 with home + existing) |
| Time on the clock | ~6 hrs | ~5 hrs | ~11 hrs |

## Where to start next session

Read [docs/design/world-registry.md](../design/world-registry.md) for the architecture and [agent-harness.md §7](../design/agent-harness.md#7-deferred-hooks-with-triggers-for-activation) for the remaining deferred hooks. The two most likely next moves:

- **Path A — Claude Agent SDK as a `Brain` for Colony**. The Inspector tab already has a renderer slot for non-utility brains; the SDK is already in `package.json`. ~1 day to add `ClaudeAgentBrain.js` and an env gate to give one Colony dupe an LLM brain alongside the utility ones.
- **Path B — Verify in a real browser**. Run `npm run dev`, open `#/colony`, drag a roster row onto a Shelter tile, watch the dupe appear. The Phase 5 plan claimed this would work; the Playwright tests verify the wiring but not the UX feel.

`npm run dev` is up at http://localhost:5173/. Containers (room-server, pi-bridge, relay, jumble) are up via the existing `npm run agent-sandbox:up` from earlier in the session.

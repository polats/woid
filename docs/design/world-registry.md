# WorldRegistry + sandbox overlay — Phase 5 design

> **⚠️ SUPERSEDED (2026-05-21).** The architecture described below was implemented, then reverted the same evening. The tabbed overlay (`PersonasTab`, `RosterTab`, `RoomTab`, `InspectorTab`) was rejected in favor of a simpler single-panel `SandboxCards` drawer; the `WorldAdapter` + `getWorldRegistry()` registry was replaced by a lightweight `worldRegistry` (in `src/lib/harness/registry.js`) focused on lifecycle (drop / stop / isInstantiated) rather than telemetry / roster / portable-identity. See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../devlog/2026-05-20-phase5-worldregistry-and-overlay.md) for the post-mortem. Read this doc for historical context only — the code it describes does not exist.

The implementation plan for unifying woid's three worlds (Sims, Shelter, Colony) behind a single registry, replacing the `#/agent-sandbox` route with a dismissable overlay available across all worlds, and standardizing drag-and-drop agent spawning. Companion to [agent-harness.md](agent-harness.md) (Phases 0–4); this is Phase 5.

The forcing question this answers: **how do we know the harness actually works across our three worlds?** Phases 0–4 shipped Colony on the harness; Sims and Shelter remained on their existing codepaths. This phase produces user-visible cross-world behavior — a roster that aggregates all three, a drawer you open over any world, an Alice you drag from the roster into any world's view — that proves the unification physically rather than verbally.

Task cards: [#550](../../tasks/550-world-registry-primitive.md) through [#640](../../tasks/640-sidebar-cleanup-and-route-redirects.md).

---

## 1. Goals (and the lie this corrects)

The agent-harness Phase 0–4 plan claimed "the same harness powers Sims, Shelter, and Colony." After shipping, only Colony actually uses `src/lib/harness/`. Sims still runs on `agent-sandbox/pi-bridge/` with its own copies of the harness modules; Shelter uses its own deterministic resolver. The harness library and the per-game codepaths share *patterns* but not *code*.

This phase fixes that gap by introducing **`WorldRegistry`** — a thin cross-world data layer the sandbox UI reads through. Each world (Sims, Shelter, Colony) registers an adapter; the UI never asks pi-bridge or shelterStore directly. After the phase ships, you can:

- See all characters across all three worlds in one roster
- Drag any character from the roster onto any world's view to spawn them there
- Open an agent inspector that renders Sims's pi NDJSON and Colony's UtilityBrain decisions side by side
- Create a `PortableIdentity` in Personas once and place it in whichever world you want

That's the validation the harness needs to earn the cross-world claim.

## 2. Non-goals

- **No game-logic refactor.** Sims still runs through pi-bridge; Shelter still runs through shelterStore; Colony still runs through colonyStore. The adapters are read translators on top.
- **No moodlets convergence yet.** Pi-bridge keeps its Node `moodlets.js`; Colony keeps the browser `moodlets.js`. Both satisfy the same API; this phase doesn't merge them.
- **No new game-side endpoints.** Pi-bridge already exposes `/characters`. ShelterStore already exposes mutations. The adapters wire what exists.
- **No BYO-agent HTTP API.** Still deferred (plan §7).
- **No A2A, no MCP server.** Still deferred.

## 3. Naming

| Was | Is |
|---|---|
| "Game" section in the sidebar | "Worlds" |
| `GameRegistry` (working name) | `WorldRegistry` |
| `GameAdapter` (the existing four-method interface in `src/lib/harness/types.js`) | **stays** — `GameAdapter` is the per-game runtime contract; `WorldRegistry` is the cross-world *index*. They compose. |
| `#/game` route (Sims) | **stays** — too much churn to rename, low value. The conceptual term is "world" everywhere except this URL. |
| `src/views/Game.jsx` | **stays** — same reason. |
| `#/agent-sandbox` route | **redirects** to the active world's view with the sandbox overlay open. Deep-linkable. |
| `#/rooms` route | **removed** — each world's view is its own room view. |

## 4. The WorldRegistry interface

```ts
// src/lib/harness/world-registry.js

export type WorldId = 'sims' | 'shelter' | 'colony' | string;

export type WorldStatus = 'ok' | 'offline' | 'empty';

export type RosterEntry = {
  worldId: WorldId;
  characterId: string;           // game-local; unique within world
  identityId?: string;           // optional PortableIdentity.id for cross-world dedupe
  name: string;
  avatarUrl?: string;
  // Game-specific details; for display only.
  details?: Record<string, unknown>;
};

export type DropTarget = {
  worldId: WorldId;
  // The drop target's coordinate shape is opaque to the registry; the
  // world view fills it in and the world's own spawn() reads it.
  payload: Record<string, unknown>;
};

export interface WorldAdapter {
  worldId: WorldId;
  status(): WorldStatus;
  // Cross-world roster: every character/agent/dupe in this world.
  roster(): Promise<RosterEntry[]>;
  // Place an identity into this world. The `target` shape is per-world.
  spawn(identity: PortableIdentity, target: DropTarget['payload']):
    Promise<{ characterId: string }>;
  // Inspector telemetry — per-character brain decisions / NDJSON / etc.
  // Returns null if the world doesn't support telemetry yet.
  telemetry(characterId: string): TelemetryStream | null;
  // Cross-world referencing: look up an identity by id.
  findByIdentityId?(identityId: string): Promise<RosterEntry | null>;
}

export interface WorldRegistry {
  register(adapter: WorldAdapter): void;
  worlds(): WorldAdapter[];
  byId(worldId: WorldId): WorldAdapter | null;
  // Aggregate roster across every registered world. Filters out
  // offline worlds gracefully (status = 'offline' returns [] for that world).
  allRoster(): Promise<RosterEntry[]>;
}

// Browser singleton; lazy on first use.
export function getWorldRegistry(): WorldRegistry;
```

`WorldAdapter` and the existing `GameAdapter` are different interfaces serving different layers:

- `GameAdapter` lives inside a single game's tick loop. It's how the harness's `Brain` observes that game.
- `WorldAdapter` lives at the registry layer. It's how the cross-world UI reads from every game.

A game may implement both. Colony already has a `GameAdapter`; Phase 5 adds Colony's `WorldAdapter` separately, satisfying the registry.

## 5. The three world adapters

### `src/lib/sims/world.js` — Sims adapter ([#560](../../tasks/560-sims-world-adapter.md))

Wraps pi-bridge HTTP endpoints. Read-only translation, no pi-bridge changes.

- `roster()` → `GET ${bridgeUrl}/characters` → projected to `RosterEntry[]`.
- `spawn(identity, target)` → `POST ${bridgeUrl}/characters` with `{ name, about, kind: target.kind ?? 'player', x: target.x, y: target.y }`.
- `telemetry(characterId)` → SSE stream from `${bridgeUrl}/agents/:id/events/stream`, parsed as NDJSON.
- `status()` → tracks `${bridgeUrl}/health` reachability; `offline` if unreachable.

### `src/lib/shelter/world.js` — Shelter adapter ([#570](../../tasks/570-shelter-world-adapter.md))

Wraps shelterStore reads.

- `roster()` → `Object.values(shelterStore.getSnapshot().agents)` → projected.
- `spawn(identity, target)` → `shelterStore.addAgent({ id: identity.id, name: identity.name, pubkey: identity.id, ...target })`.
- `telemetry(characterId)` → returns `null` for now (Shelter has no Brain decisions to render; the resolver's schedule patches could go here as a follow-up).
- `status()` → always `'ok'` (shelterStore is in-process).

### `src/lib/colony/world.js` — Colony adapter ([#580](../../tasks/580-colony-world-adapter.md))

Extends the existing `colony/adapter.js` to also satisfy the registry shape.

- `roster()` → `Object.values(colonyStore.getSnapshot().dupes)` → projected.
- `spawn(identity, target)` → `colonyStore.addDupe(makeDupe(identity.id, identity.name, target))`.
- `telemetry(characterId)` → returns the loop's brain-decision ring buffer for that dupe (the inspector slice [#620](../../tasks/620-colony-brain-inspector.md) populates this).
- `status()` → always `'ok'`.

## 6. Sandbox overlay shape ([#590](../../tasks/590-agent-sandbox-overlay-shell.md))

A right-side slide-out drawer mounted at the app root. Reuses the existing `AgentDrawer.jsx` visual pattern (vertical tab rail).

```
┌──────────────────────────────────────────────────────────┐
│ Sims / Shelter / Colony — world view                     │
│                                              ┌──┬───────┐│
│                                              │ R│ Roster ││  ← overlay open
│                                              │ I│        ││
│                                              │ S│        ││
│                                              │ P│        ││
│                                              │ T│        ││
│                                              └──┴───────┘│
└──────────────────────────────────────────────────────────┘
                                       ⊕  ← floating button
```

### Toggle (decided)

- **Floating button** in each world view's corner (mirrors Colony's existing DEV FAB style). Visible only when overlay is closed.
- **Keyboard shortcut** `Ctrl/Cmd + ;` opens/closes regardless of route.
- **Sidebar header button** is an alias for power users.

### Tabs

| Tab | Cross-world? | Source |
|---|---|---|
| **Roster** | yes (all three worlds) | `WorldRegistry.allRoster()` ([#600](../../tasks/600-roster-tab-cross-world.md)) |
| **Inspector** | yes | `WorldRegistry.byId(world).telemetry(char)` — renderer by brain-type ([#620](../../tasks/620-colony-brain-inspector.md)) |
| **Personas** | yes (creates PortableIdentity once, spawns into any world) | ([#630](../../tasks/630-personas-in-overlay.md)) |
| **Storyteller** | **Sims-only** | pi-bridge's existing endpoints; recap + cards + intensity ([#640](../../tasks/640-sidebar-cleanup-and-route-redirects.md) scope) |
| **Room (2D map)** | Sims-only | the existing `Sandbox.jsx` RoomMap view; preserved as an inspector surface (see §8) |

The active tab is per-overlay-session, not per-route.

### Behavior when world doesn't support a tab

- Roster: always works (offline worlds show empty section).
- Inspector: shows "this world doesn't expose brain telemetry yet" for Shelter.
- Personas: always works.
- Storyteller / Room (2D map): badged "Sims" — clicking from Colony/Shelter switches the overlay to Sims context (doesn't navigate the world view, just changes what the tab shows).

## 7. Cross-world drag-and-drop ([#610](../../tasks/610-cross-world-drag-and-drop.md))

Standardize on the existing MIME pattern from `RoomMap.jsx`:

- **Drag source:** any roster row sets `dataTransfer.setData('application/x-character-pubkey', identity.id)`.
- **Drop target:** each world view registers a drop handler that:
  1. Reads `identity.id` from dataTransfer.
  2. Translates the drop event's client coordinates into the world's coordinate shape.
  3. Calls `WorldRegistry.byId(activeWorld).spawn(identity, target)`.

| World | View component | Drop handler implementation |
|---|---|---|
| Sims | `RoomMap.jsx` in Sandbox.jsx (and future home) | already wired — keep |
| Colony | `RoomMap.jsx` reused via `Colony.jsx` | pass `onDropCharacter` from Colony.jsx into RoomMap (~5 LOC) |
| Shelter | `ShelterStage3D.jsx` | new: raycast mouse position against floor planes → projector → `{ roomId, localU, localV }`. The existing `presenceProjector.js` already does the inverse mapping. |

Shelter is the only real work in this slice. ~3 hours for the raycasting drop, given the projector already exists.

## 8. Preserving everything in the old `#/agent-sandbox` route ([#640](../../tasks/640-sidebar-cleanup-and-route-redirects.md))

The user's constraint: don't lose anything from the current `Sandbox.jsx` route. Mapping:

| Was in `Sandbox.jsx` | Goes to |
|---|---|
| Agents sidebar | Overlay → Roster tab |
| `RoomMap` (2D Sims map) | Overlay → Room tab (Sims-only) |
| `Recap` component | Overlay → Storyteller tab |
| `Storyteller` component | Overlay → Storyteller tab |
| `AgentDrawer` (per-agent inspector) | Overlay → Inspector tab |
| `SimClock` | Sims world view (`Game.jsx`) header |
| In-room chat (post to Colyseus) | Sims world view (`Game.jsx`) — floating widget |
| Persona prompt editor (player-persona settings) | Overlay → Personas tab |

`#/agent-sandbox` becomes a redirect: opens the active world's view (defaulting to `#/game` for Sims) with the overlay open. Deep-linking to `#/agent-sandbox` from old bookmarks Just Works.

## 9. Cross-world identity ([#630](../../tasks/630-personas-in-overlay.md))

Decided: **game-local instances; identities are cross-referenceable.**

- Each game stores its own character record locally (Sims pi-bridge workspace; Shelter localStorage; Colony localStorage). Moodlets, relationships, position, work history — game-local.
- The `PortableIdentity` (`id`, `name`, `about`, `traits`, `voiceHints`) is the shared spine.
- Same `identityId` across worlds → two game-local records that *refer* to the same identity. Each world can read the other's records via `WorldRegistry.byId(otherWorld).findByIdentityId(id)`.

Concrete use case: "Alice is on shift in Shelter; she could surface in Sims chat as 'Alice (currently on shift)' if you click her there." The chat code doesn't reach into Shelter directly — it goes through the registry.

## 10. Slice breakdown

The phase is 10 slices, each independently mergeable, each with its own task card. Roughly 7–8 working days total.

| Slice | Card | What ships | Estimate |
|---|---|---|---|
| 5.0 | [#550](../../tasks/550-world-registry-primitive.md) | `WorldRegistry` interface + singleton + per-adapter self-registration | 0.5 day |
| 5.1 | [#560](../../tasks/560-sims-world-adapter.md) | Sims adapter (read-only translator for pi-bridge) | 0.75 day |
| 5.2 | [#570](../../tasks/570-shelter-world-adapter.md) | Shelter adapter (reads shelterStore; spawn = addAgent) | 0.5 day |
| 5.3 | [#580](../../tasks/580-colony-world-adapter.md) | Colony adapter satisfies WorldAdapter (extend existing GameAdapter) | 0.25 day |
| 5.4 | [#590](../../tasks/590-agent-sandbox-overlay-shell.md) | Overlay component + FAB + keyboard shortcut + redirect from `#/agent-sandbox` | 1 day |
| 5.5 | [#600](../../tasks/600-roster-tab-cross-world.md) | Roster tab inside overlay (replaces `#/npcs`) | 1 day |
| 5.6 | [#610](../../tasks/610-cross-world-drag-and-drop.md) | DnD spawn wired across Sims/Shelter/Colony | 1.25 days |
| 5.7 | [#620](../../tasks/620-colony-brain-inspector.md) | Inspector renderer registry; Colony UtilityBrain renderer | 1 day |
| 5.8 | [#630](../../tasks/630-personas-in-overlay.md) | Personas tab creates PortableIdentity + spawn-into-world buttons | 1.25 days |
| 5.9 | [#640](../../tasks/640-sidebar-cleanup-and-route-redirects.md) | "Game" → "Worlds"; remove `#/rooms`, redirect `#/agent-sandbox`; Sims-only badges; storyteller tab content | 0.75 day |

## 11. What this validates

After the phase ships, the harness's "works across three worlds" claim has *user-visible* evidence:

- Open the overlay from any world. The roster shows characters from Sims (live from pi-bridge), Shelter (from shelterStore), Colony (from colonyStore). Three sources, one list.
- Drag any character from the roster onto the active world's view. Each world's drop handler accepts it. The character appears.
- Click any character → Inspector shows their telemetry. Sims's pi NDJSON in the same panel that renders Colony's UtilityBrain candidates and scores.
- Open Personas → create a character → click "Spawn to Sims" then "Spawn to Colony." Same `PortableIdentity` lives in both worlds as two game-local instances.

That's the harness working across three games, demonstrated.

## 12. Risks

1. **Pi-bridge offline degrades Sims adapter only.** Mitigation: registry treats `offline` worlds as empty for read APIs; spawn returns an error.
2. **Shelter raycasting drop** is the only genuinely new code that needs designing. Mitigation: presenceProjector.js already does the inverse mapping; we add the forward raycast against floor planes (~3 hours).
3. **Overlay over Sims's existing 2D RoomMap drag-drop** must not double-fire drop events. Mitigation: when overlay is open, RoomMap's own drop only fires if the drop event isn't already consumed by the overlay.
4. **Persona "Spawn to X" UX is three buttons** — could clutter. Mitigation: single dropdown with the active world preselected.
5. **In-room chat surface move** from Sandbox.jsx to Game.jsx requires verifying the chat-to-relay path still works from a different mount point. Mitigation: a Playwright spec for "post a message from the Sims world view appears on the relay."

## 13. Open follow-ups (deferred past this phase)

- **Pi-bridge consumes harness Brain interface.** Phase 5 doesn't migrate pi-bridge; it adapts pi-bridge from the outside. Convergence is still deferred.
- **Shelter resolver as a Brain.** Same — the registry adapter for Shelter doesn't ask the resolver to fit the Brain interface; it just exposes shelterStore reads.
- **Sims/Shelter LLM brains.** Path A from agent-harness.md §7 — separate phase.
- **Cross-world "follows" (live mirror).** When Alice acts in Sims, Colony's "Alice (mirrored)" indicator updates. Possible via the existing perception bus; out of scope for this phase.

## 14. How this lines up with agent-harness.md §7

Several deferred hooks in the previous plan become more concrete or partially satisfied:

| §7 deferred hook | Effect of Phase 5 |
|---|---|
| "Shelter through GameAdapter" | Still deferred — Phase 5 introduces a `WorldAdapter` (different interface), not `GameAdapter`. |
| "Pi-bridge consumes Brain interface" | Still deferred — pi-bridge unchanged. |
| "Lazy-materialized roster (Census)" | Still deferred. |
| "Long-term moodlet tier (DF middle)" | Still deferred. |
| "A2A Agent Card on NPCs" | Still deferred. |
| "MCP server for verbs" | Still deferred. |
| "BYO-agent HTTP API" | Still deferred. |

Phase 5 closes the cross-world *validation* gap without forcing any of the above.

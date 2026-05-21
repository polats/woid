---
name: Personas in overlay — unified character creator + spawn-into-world
description: The Personas tab inside <AgentSandboxOverlay /> creates a PortableIdentity once and exposes "Spawn to <world>" buttons that call WorldRegistry.byId(world).spawn() with the new identity. Replaces the #/personas route as a cross-world surface.
status: superseded
order: 630
epic: harness
depends_on: [550, 560, 570, 580, 590]
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.8. See **[docs/design/world-registry.md §9](../docs/design/world-registry.md#9-cross-world-identity-630)**.

The current `#/personas` route (in [`src/views/Personas.jsx`](../src/views/Personas.jsx)) creates pi-bridge-side personas via `bridge/v1/personas/*`. This card moves the surface into the overlay AND extends it to produce a portable identity record that can be placed into any world.

## Deliverables

### PortableIdentity flow

- `src/lib/harness/portable-identity.js`:
  - `createPortableIdentity({ name, about, traits?, voiceHints? }) → PortableIdentity` — assigns `id`, `createdAt`, `updatedAt`.
  - `validateIdentity(identity)` — returns `{ ok, errors }`. Used by the Personas form before spawning.
- Identity persistence: an in-memory pool in the registry layer, plus a thin localStorage backing under `woid.portable-identities.v1`. The existing `MemoryIdentityStore` is the in-process API; this card adds a `LocalStorageIdentityStore` and switches the registry to use it.
- `src/lib/harness/impls/identity/LocalStorageIdentityStore.js` — same API as `MemoryIdentityStore`; persists to localStorage under the namespace key.

### Personas tab

- `src/components/PersonasTab.jsx`:
  - Two columns. Left: list of saved `PortableIdentity` records (from the LocalStorageIdentityStore). Right: editor form.
  - Editor fields: name, about (textarea), traits (chip input), voiceHints (chip input).
  - Below the editor: "Spawn to..." dropdown listing the three worlds with status badges. Each option has a small icon + name. Selecting one calls `WorldRegistry.byId(world).spawn(identity, defaultTargetFor(world))`.
  - Default targets: Sims → `{ kind: 'npc', x: 6, y: 8 }`; Shelter → `{ scheduleId: 'worker' }`; Colony → `{ x: 12, y: 8 }`.
  - After spawn → toast: "Alice spawned in Colony at (12, 8)."
  - "Open in roster" link → switches the overlay tab to Roster filtered by the spawn target world.

### Pi-bridge persona route migration

- The existing `bridge/v1/personas/*` endpoints stay (pi-bridge keeps them for its own internal use). The Personas tab's "Spawn to Sims" path *uses* those endpoints under the hood — it's just that the user flow now starts with a `PortableIdentity` (created in the tab) and the spawn handler in `sims/world.js` adapts to the pi-bridge shape. The bridge doesn't need new endpoints for this card.
- Optional: a one-time "import existing pi-bridge personas as PortableIdentity records" button. Skip for v1; add if the user asks.

### Identity edits propagate

- Editing an existing `PortableIdentity` in the tab updates the local record. Already-spawned game-local instances in each world are *not* retro-updated automatically. (Snapshot semantics: each world holds its own copy at spawn time.)
- A small "Re-sync to <world>" action per row syncs `name` + `about` to the world's existing character with that `identityId`. Useful when you tweak a character's bible after they've been placed.

## Acceptance

- Open the overlay → Personas tab. Form is empty; left column shows any previously-saved identities.
- Fill name + about, click "Save" — identity appears in the list with a generated id.
- Pick "Spawn to Colony" — overlay closes (or stays open on the Roster filtered to Colony); Colony view shows a new dupe with the chosen name in the default spawn position.
- Pick "Spawn to Sims" with pi-bridge running — character appears in pi-bridge's `/characters` list.
- Pick "Spawn to Shelter" — agent appears in shelterStore.
- Refresh the page → identities persist; world spawns also persist (each game's own storage).
- The existing `#/personas` route still loads for now (disposed of in [#640](640-sidebar-cleanup-and-route-redirects.md)).

## Non-goals

- LLM-assisted persona drafting beyond what `bridge/v1/personas/*` already does. The tab can call those endpoints for Sims-flavored generation; cross-world generation is unchanged.
- Character avatar generation. Sims-only (pi-bridge handles it); other worlds use initial-letter fallback.
- Importing pi-bridge characters as identities (one-time migration). Defer.
- Traits / voiceHints semantics. They're stored on the identity; how the world uses them is per-world.

## Risk notes

- **Spawn semantics differ per world.** Sims's POST creates a character with bridge-side processing (persona generation, avatar). Shelter's `addAgent` is synchronous. Colony's `addDupe` is synchronous. Spawn handler must be `await`-safe across all three.
- **Default spawn targets are arbitrary.** A user expecting "spawn here, where I'm looking" will be confused. Mitigation: doc the defaults; provide DnD ([#610](610-cross-world-drag-and-drop.md)) as the canonical "spawn at a specific spot" path; reserve "Spawn to..." for "drop into the default location."
- **Identity edit conflicts with game-local state.** A character's `name` shouldn't be retro-updated if the user already edited it in the game. Snapshot semantics avoid this; document it.

## Related work

- [Existing `src/views/Personas.jsx`](../src/views/Personas.jsx) — the route this tab supersedes. Disposition in [#640](640-sidebar-cleanup-and-route-redirects.md).
- [#335 — Traits system (todo)](335-traits-system.md) — promoted-trait stream feeds the editor's traits field.

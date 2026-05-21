---
name: Sidebar cleanup, route redirects, Sims surface preservation
description: Final Phase 5 slice. Rename "Game" → "Worlds" in the sidebar; remove the #/rooms link; redirect #/agent-sandbox to the active world view with overlay open; preserve every chat/recap/storyteller/roommap surface from the old Sandbox.jsx route into the overlay or the Sims world view header.
status: superseded
order: 640
epic: harness
depends_on: [550, 560, 570, 580, 590, 600, 610, 620, 630]
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.9. See **[docs/design/world-registry.md §8](../docs/design/world-registry.md#8-preserving-everything-in-the-old-agent-sandbox-route-640)**.

The user constraint: don't lose anything from the current `#/agent-sandbox` route. Chat, room movement, recap, storyteller — all must have new homes. This card does the final wiring and the cosmetic cleanups so the new overlay model is the canonical surface.

## Deliverables

### Sidebar rename

- `src/layout/Sidebar.jsx`:
  - "Game" section header → "Worlds".
  - The three world links (Sims at `#/game`, Shelter, Colony) stay where they are.
  - Add a "Sims" badge (small chip) to the Sims-only sandbox sub-links: Relay feed, Image posts, Network, Journal.
  - Remove the `#/rooms` link (each world's view is the room view now). The view file `src/views/Rooms.jsx` stays in the repo for now; the route still resolves if someone bookmarks it.
  - Remove the `#/npcs` link — superseded by the Roster tab in the overlay. Same disposition: file stays; route resolves.
  - Remove the `#/personas` link — superseded by the Personas tab.
  - Add an "Agent sandbox" button near the top of the sidebar header that toggles the overlay (alias for the FAB).

### Route redirects

- `src/App.jsx`:
  - `#/agent-sandbox` → redirect to `#/game` and open the overlay on the Roster tab (Sims context).
  - `#/rooms` → leaves the route resolving but its content is now redundant; keep for back-compat. (No action needed.)
  - `#/npcs` → continues to render `NPCs.jsx` for now; if it's clearly redundant after [#600](600-roster-tab-cross-world.md), redirect to the overlay (Roster tab, no world filter) as an optional follow-up in this card.
  - `#/personas` → same disposition as `#/npcs`.

### Sims world view absorbs preserved surfaces

- `src/views/Game.jsx` (Sims world view) — additions:
  - **Sim clock**: render `<SimClock />` in a header strip. Pulled from `Sandbox.jsx`.
  - **In-room chat (post to Colyseus)**: floating widget bottom-left of the Sims viewport. Pulled from `Sandbox.jsx`. Wraps the existing chat-send logic in a small `<RoomChat />` component.
  - **Recap + Storyteller card preview**: collapsible bar above the chat. Shows the most recent recap line ("Today, sim-day 47 — Asborn arrives in winter cold") and active storyteller card if any. Tapping expands into the overlay's Storyteller tab.

### Overlay Storyteller tab

- `src/components/StorytellerTab.jsx`:
  - Sims-only badged. When viewing from Shelter/Colony, shows "Switch to Sims to see storyteller state."
  - Renders `<Recap />` (existing) and `<Storyteller />` (existing) — these components are reused as-is.

### Overlay Room tab

- `src/components/RoomTab.jsx`:
  - Sims-only badged.
  - Renders the 2D `<RoomMap />` view of the Sims room (the one currently in `Sandbox.jsx`). Useful for inspecting the room without leaving whatever world view you're on.

### Sandbox.jsx disposition

- `src/Sandbox.jsx` becomes a thin shim that re-renders the Sims world view (now self-contained in `Game.jsx`) plus opens the overlay. After this card lands, no remaining feature depends on `Sandbox.jsx`'s implementation; it can be deleted in a follow-up. For safety, keep the file as a re-export for one cycle.

### Documentation

- Top-level `README.md`: update the "What's inside" section's Agent harness paragraph to reflect the cross-world overlay model and link [`docs/design/world-registry.md`](../docs/design/world-registry.md).
- `src/lib/harness/docs/HARNESS.md`: add a brief "Cross-world overlay" section pointing at the WorldRegistry interface.
- `src/lib/harness/docs/integrating.md`: add a "Registering your world" section showing the `WorldAdapter` plumbing.

## Acceptance

- Sidebar shows "Worlds" header; Sims/Shelter/Colony nested.
- `#/agent-sandbox` redirects to `#/game` with the overlay open on Roster.
- Sims world view shows sim clock, in-room chat, recap preview — all functional.
- Posting from the in-room chat in `#/game` appears in the Nostr relay (same path as before, different mount).
- Overlay's Storyteller tab from Sims shows the full Recap + Storyteller components.
- Overlay's Storyteller tab from Colony/Shelter shows the "Sims-only" empty state.
- Overlay's Room tab from Sims shows the 2D RoomMap.
- Playwright smoke: visit `#/agent-sandbox` → URL changes to `#/game`, overlay is open, Roster shows Sims characters.
- Existing Sims spec doesn't regress.

## Non-goals

- Removing `Rooms.jsx`, `NPCs.jsx`, `Personas.jsx`, `Sandbox.jsx` from the file system. Stays for one cycle; deletion is a follow-up after a release of bake time.
- Mobile responsive overlay. Desktop only for this phase.
- Renaming `#/game` → `#/sims` or `Game.jsx` → `Sims.jsx`. The user explicitly opted out.
- A2A, MCP, BYO-agent HTTP API. Still deferred.

## Risk notes

- **In-room chat at a new mount point.** The current chat in `Sandbox.jsx` is tightly woven with the agent sidebar UI. Extracting `<RoomChat />` as a standalone component must verify: posting works, send button disables during send, errors surface visibly. Playwright spec verifies the round-trip to the relay.
- **Recap component pulled out of context.** `Recap.jsx` may have expected to live inside `Sandbox.jsx`'s state. Verify it accepts the recap data via props or hooks; if it reaches into Sandbox internals, refactor first.
- **Storyteller card animations.** If `Storyteller.jsx` uses Framer Motion or similar, ensure the overlay tab mount doesn't break the animation lifecycle.
- **Sidebar visual regression.** The "Worlds" rename is a one-line change but visual review post-deploy is worth a moment.

## Why this card last

Phase 5 needs all prior cards to land before this one. Without [#600](600-roster-tab-cross-world.md), the redirect destination's Roster tab is empty. Without [#620](620-colony-brain-inspector.md), the Inspector is half-empty. Without [#630](630-personas-in-overlay.md), the Personas tab redirect target is the old route. This card ties them together and removes the scaffolding from old routes.

## Related work

- All previous Phase 5 cards.
- [#195 — Documentation pass (done)](195-agent-sandbox-docs-pass.md) — sister pattern; the new docs updates here follow the same shape.

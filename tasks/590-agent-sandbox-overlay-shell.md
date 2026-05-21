---
name: AgentSandboxOverlay shell — right-side drawer + FAB toggle + redirect
description: Replace the #/agent-sandbox route with a dismissable right-side drawer. Floating button per world view + Ctrl/Cmd+; keyboard shortcut. The drawer reuses the AgentDrawer.jsx visual pattern; this card lands the shell with empty tabs (content lands in #600-#640).
status: superseded
order: 590
epic: harness
depends_on: [550]
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.4. See **[docs/design/world-registry.md §6](../docs/design/world-registry.md#6-sandbox-overlay-shape-590)**.

Lands the drawer scaffold + the toggle affordances + the route-redirect logic. Empty tabs are placeholders for [#600](600-roster-tab-cross-world.md), [#620](620-colony-brain-inspector.md), [#630](630-personas-in-overlay.md), and [#640](640-sidebar-cleanup-and-route-redirects.md).

## Deliverables

- `src/AgentSandboxOverlay.jsx` (top-level — mirrors `Chat.jsx` placement, not a `views/` file because it's not a route):
  - Right-side slide-out drawer. Reuses the visual pattern from `src/AgentDrawer.jsx`. Backdrop `pointer-events: none` so the world view underneath stays interactive.
  - Tab rail (vertical, left edge of drawer): Roster / Inspector / Personas / Storyteller / Room. Tabs render placeholder "coming in #6XX" copy for this card.
  - Header shows the active world: "Roster — Colony" / "Roster — Sims" etc. World defaults to the route the user is on (`#/colony` → Colony; `#/shelter` → Shelter; `#/game` / `#/agent-sandbox` → Sims).
  - Close button + Esc-to-close.
- `src/hooks/useOverlayState.js`:
  - `useOverlayState()` — `{ open, openOverlay, closeOverlay, toggle, activeTab, setActiveTab, activeWorld, setActiveWorld }`. Backed by a module-level signal + React subscription so any component can read/write it. (Pattern: simple custom hook around a Set of subscribers; no Zustand-style dep introduced.)
  - Persists `activeTab` in `sessionStorage` so reopening the overlay restores the last tab.
- `src/components/AgentSandboxFab.jsx`:
  - Floating action button. Positioned bottom-right by default (configurable via props for views that already have a FAB — Colony's existing DEV button stays; the new sandbox FAB sits a step higher).
  - Renders only when `useOverlayState().open === false`.
- Keyboard shortcut: `Ctrl/Cmd + ;` toggles the overlay. Wired in `App.jsx` once.
- Sidebar header button: re-uses the sandbox-link area as a toggle when the overlay is closed (per [#640](640-sidebar-cleanup-and-route-redirects.md) styling).
- Route handling in `App.jsx`:
  - `#/agent-sandbox` redirects to `#/game` and opens the overlay on the Roster tab. Sims context.
  - The `<AgentSandboxOverlay />` is mounted *once* at the app root (next to Sidebar / main content area), not inside any specific view.
  - World views render the FAB component (`AgentSandboxFab`) themselves so the button positioning is per-view.
- Add the FAB to Sims (`Game.jsx`), Shelter (`Shelter.jsx`), Colony (`Colony.jsx`).

## Acceptance

- With overlay closed, the FAB is visible in each world view's corner. Clicking opens the drawer.
- With overlay open, Esc closes it. Click on the close button closes it.
- Ctrl/Cmd+; toggles regardless of active world.
- Switching worlds via the sidebar while overlay is open updates the header context: "Roster — Sims" → "Roster — Colony".
- Visiting `#/agent-sandbox` redirects to `#/game` and opens the overlay.
- The world view underneath remains interactive when the overlay is open (e.g., you can still click tiles in Colony).
- Empty tabs render placeholder text identifying which task card will fill them.

## Non-goals

- Tab content. Empty placeholders only. Content lands in [#600](600-roster-tab-cross-world.md), [#620](620-colony-brain-inspector.md), [#630](630-personas-in-overlay.md), [#640](640-sidebar-cleanup-and-route-redirects.md).
- Mobile-responsive drawer. Desktop layout only for this card; mobile (overlay covers full screen on narrow viewports) is a polish follow-up.
- Removing the existing `Sandbox.jsx` file. It's referenced by the old route; the redirect points away from it but the file stays for [#640](640-sidebar-cleanup-and-route-redirects.md) to disposition (preserve the chat/recap/storyteller surfaces it carries).
- Animation polish. CSS transitions are fine; no Framer Motion plumbing in this card.

## Risk notes

- **Z-index conflict with Colony's existing DEV FAB** (bottom-right). Position the sandbox FAB at bottom-right *plus 60px above* so they stack. Both visible at the same time is fine — different surfaces.
- **Overlay over Sims's existing AgentDrawer.** If the user opens the new overlay AND clicks an agent (which previously opened AgentDrawer), the drawer-inside-drawer is visually confusing. Mitigation: close any open AgentDrawer when the new overlay opens; route inspection through the overlay's Inspector tab going forward (covered by [#620](620-colony-brain-inspector.md)).
- **`#/agent-sandbox` deep-linking.** Existing bookmarks must still land somewhere useful. The redirect-with-overlay-open pattern is the right answer; verify with a Playwright spec.

## Related work

- [#135 — Harness abstraction (done)](135-agent-sandbox-harness-abstraction.md) — pi-bridge's own drawer pattern this card visually echoes.
- [#175 — External driver status (todo)](175-agent-sandbox-external-driver-status.md) — would slot as another overlay tab eventually.

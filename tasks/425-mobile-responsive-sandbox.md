---
name: UI — Mobile responsiveness for Agent Sandbox
description: The Sandbox view (3-column grid: cards | stage | drawer) is unusable on mobile. No `@media` queries exist anywhere in styles.css. Phased fix: ship a usable single-column stack on narrow screens first, then per-tab polish.
status: in_progress
order: 425
epic: ui
related: [305, 385, 415]
---

The desktop layout assumes ≥1024px:

- `.sandbox3` is `grid-template-columns: 280px 1fr` (cards aside + stage).
- `.agent-drawer` is absolute-positioned and expands the grid to ≥744px wide when open.
- `.sidebar` (app nav) takes a fixed 240px column to the left of the content area.
- `.sandbox3-stage` packs tabs (Room / Recap / Storyteller), a chat log, and an input form into a fixed grid.
- `RoomMap` is a tile grid with absolute-positioned children at fixed pixel coords.

There are zero `@media` queries in styles.css today. On a 375px-wide phone, the stage tabs overflow, the cards aside crowds out the map, and tapping any card opens a 420px-wide drawer that exceeds viewport width.

## Slices

### Slice 1 — Audit + breakpoint (this task)

- Single mobile breakpoint: `(max-width: 768px)`.
- Inventory of broken surfaces (this section).

### Slice 2 — Sandbox stack (ship first — unblocks everything else) — DONE

- `.sandbox3` collapses to one column: cards aside on top (horizontal scroll strip, max-height ~32vh), stage below.
- `.sandbox3:has(.agent-drawer)` override falls back to single column too — drawer is a fullscreen overlay on mobile.
- `.agent-drawer-main` becomes `width: 100vw`; the desktop unfold-from-cards animation is replaced with a simple slide-in from the right; the dimmer covers the viewport.
- `.sidebar` becomes `position: fixed` overlay when not collapsed (slides over content). App.jsx defaults to collapsed when `(max-width: 768px)` matches on first load.
- `.sandbox3-stage-tabs` wrap; tabs use 6×10 padding, 10px font.

Verified at 375×812: cards strip scrolls horizontally, all 3 stage tabs reachable, Storyteller intensity gauge fits, AgentDrawer opens fullscreen with reachable close affordance.

### Slice 3 — Per-tab polish

- **Storyteller**: meta row already wraps; tighten section paddings, ensure card pool tile widths flow.
- **Recap**: image strip wraps (already does via flex-wrap); shrink card padding.
- **Image Posts**: grid is auto-fill so it adapts; the detail pane (380px) shifts under the grid as a full-width section instead of a right rail.
- **Personas**: shrink table paddings; allow horizontal scroll on the table itself.

### Slice 4 — Sidebar polish + RoomMap

- Sidebar slide-over animation, dim background.
- RoomMap wrapped in `overflow: auto` with `touch-action: pan-x pan-y`; allow native pinch-zoom (or add zoom controls in a follow-up).

## Acceptance

- On a 375px-wide viewport: the Storyteller tab is reachable, the intensity bar fits, you can tap Fire on a card, the fire log + bindings link work.
- The Sandbox cards aside is reachable via horizontal scroll without obscuring the stage.
- Tapping a character opens the AgentInspector drawer fullscreen with a visible close affordance.
- The Recap tab shows image thumbnails without horizontal page-scroll.
- The app sidebar nav is hidden by default; tapping the reopen chevron slides it over the content.

## Non-goals

- Native mobile app / PWA install.
- Touch-optimised drag-drop on the room map (slice 4 punts to a follow-up).
- Landscape-specific tweaks (handled by the same single breakpoint).

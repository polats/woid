---
name: World — Schedule editor UI in drawer
description: Make the per-character Schedule drawer tab editable. Click a slot row → inline picker of available rooms → PATCH /schedules/:pubkey override. Today the tab is read-only and override changes require curl.
status: todo
order: 395
epic: world
depends_on: [285]
---

`AgentSchedule.jsx` already shows the four slots and their target rooms with an "override" pill. The bridge already has `PATCH /schedules/:pubkey` accepting `{slot, room_id}`. Frontend just needs the UI to drive it.

## Slices

### Slice 1 — Click-to-edit slot row

- Click on a slot's `.agent-schedule-target` cell → swap to a `<select>` listing all rooms (id, name, type chip).
- On change → `PATCH /schedules/:pubkey { slot, room_id }`.
- Optimistic update + revert on error.
- Re-fetch effective timetable after success.

### Slice 2 — Reset-to-default action

- Each row gets a tiny "↺" button visible only when the row is overridden.
- Click → `PATCH /schedules/:pubkey { slot, room_id: null }` (or send `{slot}` with no room_id; bridge interprets as clear).
- Override pill disappears once cleared.

### Slice 3 — "Set whole day" composite

- A small "preset" dropdown above the slot list: `Default` / `Night owl` / `Routine-locked` / `Custom`.
- Selecting a preset PATCHes `/schedules/:pubkey { timetable: {...} }` wholesale.
- Custom = no preset matched; user is in mixed override territory.

## Acceptance

- User opens Schedule tab → clicks `Kitchen` for the morning slot → picker opens → selects `apt-1B` → row updates with override pill.
- The schedule mover (next tick) nudges the character toward apt-1B in the morning.
- Reset button clears the override and the row reverts to default kitchen target.

## Non-goals

- Drag-to-reorder slots (slots are fixed: morning/midday/afternoon/evening).
- Custom slot names / counts. Future-only — would require schedule.js shape changes.
- Per-room time-of-day windows (e.g. "kitchen only 06:00–09:00"). The slot is the granularity.

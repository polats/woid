---
name: World — Shop, currency, and room/object unlocks
description: Light AC/Tomodachi-shape economy. Small daily allowance + milestone bonuses. Shop sells objects (new affordances) and unlocks new building rooms. Currency is the player's investment surface; nothing is gated behind grinding.
status: todo
order: 325
epic: world
depends_on: [275, 285, 305]
---

Specified in [docs/design/vertical-slice.md §4](../docs/design/vertical-slice.md#4-the-world-day-1-baseline) and §11. The player-agency layer that sits on top of the storyteller engine.

The audience design rule: **currency is non-grindy and never gates *people*.** It only gates *interactions and spaces*. The user can always talk to anyone; what they're choosing is *what new things can happen*.

## Slices

### Slice 1 — Currency model

- Per-workspace `world.currency` (¤) with default starting balance 0.
- Daily allowance: 3¤ awarded at session_open.
- Milestone bonuses: relationship transitions (+2¤), trait promotions (+1¤), arc completions (+3¤).
- Persistence: `$WORKSPACE/world.json` with a `currency` field.
- HTTP: `GET /currency`, `GET /currency/history`.

### Slice 2 — Shop UI

- `src/Shop.jsx` — modal or sidebar panel.
- Day-1 shop inventory per [docs/design/vertical-slice.md §4](../docs/design/vertical-slice.md#day-1-shop-inventory): cookbook (2¤), houseplant (1¤), journal (1¤), vinyl player (3¤), candle (1¤), kettle accessories (1¤).
- Each item declares: cost, object type to spawn, room-unlock condition (if any), affordances unlocked (preview text).
- Buy → currency debit + `place` flow (drag onto a room tile).

### Slice 3 — Affordance unlock routing

- When an object is placed, its affordances become eligible for cards in that room.
- Cards filter their `room:` and required-object preconditions against placed objects.
- Example: `argument.music-volume` requires a vinyl-player object placed in a communal room.
- Object placement emits `object_placed` perception event so witnessing characters can react.

### Slice 4 — Room unlocks via shop

- Per [docs/design/building.md §3.2](../docs/design/building.md#32-room-unlocks-open-new-spaces-in-the-building):
  - Placing the first kettle/cookbook/fridge accessory in a hallway upgrades it to a communal kitchen.
  - Placing a houseplant on the building exterior tile unlocks the garden.
- Unlock events fire `room_unlocked` perception events; recap leads with the unlock.

### Slice 5 — Apartment unlocks

- 2A unlocks at 3rd resident; 2B at 4th. Threshold logic in `building.js`.
- A "Welcome a new resident" button surfaces when an apartment is unlocked.
- Two flows:
  - User-authored: same as today, fill in `about` etc.
  - System-seeded: storyteller proposes a candidate (with `about` pre-filled); user can accept, reject, or edit.

## Acceptance

- A fresh workspace starts with 0¤; after one sim-day passes, balance is 3¤.
- Buying a houseplant for 1¤ debits the balance; placing it in a room emits `object_placed` and makes `tend_plant` cards eligible.
- After 3 residents are welcomed, 2A apartment unlocks visibly in the BuildingCanvas; the recap mentions it.
- Placing a kettle in the hallway upgrades it to a communal kitchen; new cards (`ambient.morning-kettle`) become eligible.
- A relationship transition (acquaintance → friend) awards 2¤ and posts a milestone notification.

## Non-goals

- Crafting / recipes / multi-item combos.
- Paid currency / IAP / premium shop.
- Trading currency between characters or between workspaces.
- Time-gated daily login bonuses or streak punishments. Streaks are cosmetic only.
- Object durability or maintenance loops.

## Risk notes

- Currency tuning needs to feel *generous*. The audience bounces if "I'm always broke." Default rates skew so an active player can buy 3–5 small items in their first week without choosing carefully.
- Don't ship gacha mechanics, energy systems, or FOMO timers. The audience contract for [vertical-slice.md §1](../docs/design/vertical-slice.md#1-audience) is broken if any of those land.
- Object-affordance routing complexity grows with object count. Keep affordances declarative on the object type, not authored per-card.

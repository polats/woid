---
name: World phase 3 — Smart Objects on the map
description: Map objects advertise affordances (Sims pattern). NPCs query nearby objects for what they offer; utility scoring against the needs vector picks an interaction. The world tells NPCs what they can do, not the other way around.
status: todo
order: 245
epic: world
---

Depends on #225 (verb set) and #235 (needs vector). This phase makes "go to the bakery" resolve to a concrete object that knows how to be interacted with, instead of an abstract location label.

Research case (see `docs/research/the-sims.md`, `docs/research/rimworld.md`, `docs/research/metaverse-platforms.md` on Astron tagged-fields):

- The Sims smart-object architecture is the most-borrowed game-AI pattern of the last 25 years for a reason. Objects own their interactions and advertise them with utility numbers; NPCs are dumb consumers.
- Astron's tagged-field model (`broadcast` / `db` / `airecv`) is the cleanest published way to declare what about an object replicates, persists, or stays server-only.
- Mozilla Hubs's "ephemeral by default, pin to persist" model is the right default for object state — most things are transient; explicit persistence is opt-in.
- Tomodachi Life's standardized apartments: vary the contents, not the geometry.

## Deliverables

### Smart Object schema

- `agent-sandbox/shared/objects.js` — declarative object types. Each type declares:
  - `affordances`: list of `{ verb, preconditions, utility(needs, npc) → score, effects }`
  - `state`: typed fields with Astron-style tags — `broadcast` (replicated to clients), `db` (persisted), `local` (server-only).
  - `capacity`: how many NPCs can use it concurrently (chair=1, room=many).
- Initial object set: chair, bed, table, fridge, stove, door, sink, toilet, bookshelf, jukebox, sign. ~10 types is enough for phase-3 demos.

### Object instances on the map

- Map data extends to include placed objects with `(type, position, owner_room, instance_state)`.
- Server-side registry tracks all object instances; affordance queries happen against this registry filtered by spatial proximity.
- Persistence: `db`-tagged fields go to SQLite (extends the schema from #215). On boot, object state restores; ephemeral fields don't.

### Affordance query API

- New verb in #225's grammar: `query_affordances(radius)` returns `[{ object_id, verb, score }]` ranked by utility.
- The phase-2 LLM gate uses this as input when picking what to do for a triggered need: "I'm hungry, what's nearby that satisfies hunger?"
- Pure-rules behavior also uses it: timetable templates can declare `find_object(type=fridge) → use` and resolve at runtime.

### Standardized space templates

- A "home" template instantiated per resident NPC — same geometry, varied object set. Tomodachi Life apartment pattern.
- A "public" template for shared spaces (cafe, plaza).
- Map authoring becomes "place templates" + "swap furniture," not "draw every room."

### Owner authority

- Object state mutations always go through the GM (#225). No client-authoritative writes — Hubs's owner-auth is for *avatar transforms*, not for shared object state.
- The `airecv`-tagged fields (e.g. internal cooldowns) never leave the server. Verify in tests.

## Acceptance

- An NPC with high hunger near a fridge picks `use(fridge)` deterministically via utility scoring, with no LLM call.
- Two NPCs cannot occupy the same single-seat chair (capacity enforced).
- Restarting the bridge restores object state for `db`-tagged fields; ephemeral fields reset.
- A new "home" instance is created in <100ms by template instantiation; placed objects are queryable immediately.
- The inspector shows per-object affordance scores against a selected NPC for debugging.
- 50 simultaneous object queries per simulated minute resolve in <10ms total (the registry scales by spatial index, not full scan).

## Non-goals

- Wired-style in-world programmable triggers (Habbo pattern from `docs/research/habbo-hotel.md`) — interesting but not phase 3.
- User-generated objects via SDK upload (VRChat-style) — phase 3 ships a fixed type registry.
- Multi-NPC interactions on a single object (two NPCs cooking together) — single-occupant only for now.
- Object-driven narrative events ("the jukebox plays a meaningful song") — that's phase 4 territory.

## Risk notes

- Utility scoring is famously hard to tune. Start with simple linear functions of needs; resist the urge to ship a curve editor.
- Spatial indexing: a flat array works for <500 objects. Switch to a grid hash only when measured. Don't pre-optimize.
- Capacity enforcement races: two NPCs querying simultaneously can both think a chair is free. Use the GM's serialized validation as the single source of truth — affordance scores are advisory, the GM call is authoritative.

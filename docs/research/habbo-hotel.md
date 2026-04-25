# Habbo Hotel — 25 years of persistent isometric rooms

Habbo (Sulake, since 2000) went through Director → Shockwave → Flash → Unity/HTML5 (Habbo2020). Most public technical detail comes from leaked client decompilations, the Habbo Hotel Wiki, and emulator projects (Arcturus Morningstar, PRODIGY, Plus EMU) that re-implement the protocol.

---

## Isometric tile world

Each room is a heightmap — a 2D char grid where each tile is `0`–`9` / `a`–`z` for stack height, `x` for blocked. Rooms have a model ID (the floor plan) and a separately stored set of placed **furni**.

## Per-room ownership + per-room state

Every room has:

- an owner user ID
- access door type (open / locked with password / doorbell / invisible)
- background music (traxmachine soundtracks)
- wallpaper / floor / landscape
- furni list

Furni are typed objects with class-defined behavior: dice, teleporter pairs, vending machines, beds with sit/lay states, traxmachine, **wired triggers/effects/conditions** (Habbo's in-world programmable logic — the closest thing in any consumer game to user-built behavior trees).

State persists in the database keyed by room + furni instance.

## Server architecture

Sulake's stack went from a Director-based monolith to a Java-based server (mid-2000s) that handles rooms as in-memory objects loaded on first user entry and unloaded after a TTL with no occupants.

Scaling was sharded by **hotel** — separate `.com`, `.es`, `.fi`, `.com.br` deployments, each a different DB and user pool. Within a hotel, rooms are partitioned across game-server processes; a router (originally a Director multiuser server, later custom Java) directs you to the right node by room ID.

Open emulator code (Arcturus on GitHub) shows roughly:

- one event loop per hotel handles all rooms with cooperative scheduling
- room ticks at 500ms
- Netty for client I/O
- MySQL for persistence with write-behind for furni state
- **no per-room process** — rooms are objects sharing a thread pool

## Furni interaction

"Click while adjacent" — server validates tile distance, runs the furni's interaction handler (state transition, sometimes wired-script execution), broadcasts the new state to everyone in the room. Limits are typical 25–50 users/room (varies by hotel and room owner club status).

## Habbo Wired

Habbo's killer feature: users can wire up triggers → conditions → effects within their own rooms, no code. A simple wired program:

- Trigger: "user walks on this tile"
- Condition: "user is in club"
- Effect: "teleport to other tile + play sound"

This is a *visual programming environment built into a consumer chatroom* — kids have been authoring behaviors with it for two decades.

---

## Lessons for an LLM sandbox

- **Rooms as lazy-loaded, TTL-evictable in-memory aggregates.** Don't run every room all the time. Load on first occupant, snapshot to DB on writes, evict when empty for N minutes. For our LLM NPCs: NPC "minds" sleep with the room.
- **Furni-as-typed-object with persistent state.** Habbo's furni system is the same shape as Sims smart objects, but persistent and user-placed. Our `WorldObject` schema should be similarly flexible — kind + position + persistent state + verbs.
- **Wired-style in-world programmable interactions.** Triggers / conditions / effects as composable tiles let users (and authoring tools) script object behavior without code deploys. Maps cleanly to "tools an NPC can use" and "events that wake an NPC."
- **One event loop, many rooms, cooperative ticks.** Don't spawn a process per room or per agent. Use a worker pool; rooms and agents are objects sharing it. (KCD2 does the same, just with full simulation per NPC instead of per room.)
- **Sharded by world / instance, not by user.** Hotels were the unit of isolation, not single users. For us, "world instances" (sandbox A, sandbox B) would be the equivalent unit.

---

## Sources

- [Habbo Hotel Wiki](https://habbo.fandom.com/)
- [Arcturus Morningstar emulator source](https://git.krews.org)
- Sulake dev interviews on Game Developer / Gamasutra (ca. 2008)
- Archived Habbo Sulake Tech Blog posts about the 2020 Unity port

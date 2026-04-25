# Other social worlds — VRChat, Spatial, Club Penguin, Toontown

A short reference covering platforms whose mechanics are smaller in scope than Gather/Habbo/Hubs but contribute specific patterns worth borrowing.

---

## VRChat

Networking: **Photon** (originally PUN, now custom on top of Photon's relay). Each instance is capped — ~80 hard ceiling on PC, lower on Quest. Above that you create a new instance of the same world.

Worlds and avatars are **user-generated** Unity asset bundles uploaded via their SDK, distributed as platform-specific binaries (PC / Quest / iOS).

Real-time sync uses Photon's interest groups; voice is a separate Photon Voice channel with **distance-attenuated** mixing done client-side — each client gets all peers' streams and attenuates by world position. Expensive, but lets users tweak personal mixing.

A **master client** (one user) is authoritative for shared object state; failover when they leave.

## Spatial.io / Horizon Workrooms

Spatial.io is Unity-based with their own networking layer. Horizon Workrooms uses Meta's proprietary stack.

The shared lesson with VRChat: **cap per-instance and shard rather than scale up.** Every successful social VR platform converges on 25–100 concurrent per instance and runs many instances of the same world.

---

## Club Penguin

Ran on Smartfox Server (Java). The world was divided into **rooms** (the Town, Plaza, Iceberg, etc.) and each room sharded across **servers** ("Blizzard," "Sleet"…) with a soft cap (~80 penguins/room). When full, the server spawned another instance of that room or pushed you to a different server.

One Smartfox process hosted many rooms. Rooms were lightweight (positions, tile-based pathfinding identical in concept to Gather: click a point, server interpolates the walk path, broadcasts to room peers).

**Mini-games** (Sled Race, Card-Jitsu) ran in dedicated game rooms with their own state machine; results posted back to the player's persistent profile (coins, inventory) over a separate API.

**Scheduled events** — parties, like the Halloween Party reskinning the whole island — were content drops: room art swapped on a date, new items unlocked, party-only rooms toggled on. Daily login was a flag on the player record checked on connect.

## Toontown

Disney, 2003–2013. Interesting because Disney open-sourced **Panda3D** (its engine) and the **Astron** server-distributed-object framework lives on.

Astron treats every entity as a networked object with fields tagged:

- `broadcast` — replicate to all clients in interest
- `ram` — server-cached
- `db` — persisted
- `airecv` — AI-only (server-side)

Multiple **AI servers** shard districts. A **state-server** holds the canonical object graph. Client-agents proxy clients. This is one of the cleanest published designs for sharded persistent worlds.

[github.com/Astron/Astron](https://github.com/Astron/Astron) has the spec.

---

## Lessons for an LLM sandbox

- **Cap-and-shard, don't scale up.** Every social-world platform converges on 25–100 concurrent per instance + many instances. We should plan for room caps from day one rather than trying to make one giant room work.
- **Tagged fields on networked objects (Astron's pattern).** When defining an NPC or a furni-like object, declare which fields replicate to clients, which persist, which are server-only. Beats ad-hoc "what gets sent where." This is one of the most under-used patterns in modern multiplayer design.
- **One process, many rooms, cooperative ticks.** Smartfox / Habbo / Astron all converge on this — never one process per room.
- **Master-client / owner-authority for transient state.** VRChat hands transform authority to clients. We mostly don't, but the *principle* — "one writer per piece of state, server validates consistency" — is reusable for world objects.
- **Scheduled events as content drops.** Club Penguin's parties were toggled by date flags. The sandbox equivalent: "tonight at 8 PM the cafe gets a jukebox" is a scheduled object-state change, not a custom feature.

---

## Sources

- [Astron framework](https://github.com/Astron/Astron) and Panda3D documentation
- [Club Penguin Rewritten / CPPS source](https://github.com/cprewritten) (multiple emulator repos)
- VRChat developer documentation
- ex-Disney/RocketSnail dev interviews on Game Developer

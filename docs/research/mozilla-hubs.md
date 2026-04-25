# Mozilla Hubs — open-source 3D, why hosted sunset

Open source — repos on GitHub: `mozilla/hubs`, `mozilla/reticulum`, `mozilla/dialog`.

---

## Stack

| Layer | Technology |
|---|---|
| Client | A-Frame on Three.js, custom NAF (Networked-Aframe) for entity sync |
| Reticulum | Phoenix/Elixir signaling and orchestration. Handles auth, room creation, scene metadata, presence (Phoenix Channels), brokers WebRTC negotiation |
| Dialog | mediasoup-based SFU for audio and optionally video. Initially Janus; migrated to mediasoup/dialog around 2020 |
| Spoke | Scene editor; scenes are GLTF + JSON with components (spawn points, media frames, waypoints, audio zones) |

## Persistence model

Scenes and avatars are GLTF assets stored in their asset service. Rooms reference a scene ID and a small mutable state blob (pinned objects, room name, member roles).

**Object state inside a room is mostly ephemeral.** When the last person leaves, transient objects vanish unless **pinned** by a moderator (pinned state is written to Reticulum). This is a deliberate design call: avoid running a persistent simulation per room.

NAF uses an **owner-authority** model — whichever client spawned an entity owns its transform updates, transmitted over the Phoenix Channel as compressed deltas (typically 10–20 Hz). Ownership transfers when the owner leaves.

## Why hosted Hubs sunsetted (May 2024)

[Mozilla's writeup](https://hubs.mozilla.com/labs/sunset/) cited cost-per-user, not protocol failure.

The actual scale issues that show up in their GitHub issues and talks:

- **SFU bandwidth dominated cost** — audio mixing for 25+ users
- **Reticulum room-state contention** as rooms grew past ~50 users
- **GLTF asset hosting bandwidth** — assets had to come from somewhere, and Mozilla was hosting them
- **The asymmetric cost of a free/open service on AWS**

Hubs Cloud (their self-hosted product) AMI architecture on AWS is documented at [hubs-cloud-getting-started](https://hubs.mozilla.com/docs/hubs-cloud-getting-started.html) — a single EC2 + RDS + S3 stack per tenant. Illustrative of how small a "complete metaverse server" can be.

---

## Lessons for an LLM sandbox

- **Owner-authority entity sync.** Don't try to authoritatively simulate every avatar position on the server. Owner-auth with server-side validation of "did you cheat" (collision, teleport distance) is far cheaper. Reserve server authority for things that matter: object state, currency, NPC actions.
- **Ephemeral-by-default room contents with explicit pin-to-persist.** Most state should be transient. Persistence is opt-in (the user pinned it, the system promoted it). For us: NPC mood persists across spawns; mid-conversation utterances do not.
- **Scene-as-GLTF + components.** A scene is a static asset + a small list of typed component overlays (spawn points, audio zones, interaction triggers). The world structure isn't simulation; it's data.
- **Separate signaling (stateful, sticky) from media (SFU, horizontally scalable).** State of a room is sticky to one server; bandwidth-heavy stuff scales horizontally. We don't have media, but the principle applies: the bridge holds character state; scaling concerns are different from the relay's.
- **The lesson of Hubs' sunset: separate state, media, and assets so they can scale independently.** Mozilla bundled everything into one cost center and the unit economics broke. Same trap is easy to fall into: don't put your DB, your relay, your S3, and your bridge on the same Railway plan.

---

## Sources

- [Mozilla Hubs — GitHub org](https://github.com/mozilla)
- [Hubs Cloud architecture docs](https://hubs.mozilla.com/docs/hubs-cloud-getting-started.html)
- [Mozilla Hubs — sunset writeup (2024)](https://hubs.mozilla.com/labs/sunset/)
- mediasoup, Janus engineering blog posts

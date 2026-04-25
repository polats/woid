---
name: Storage scale-out phase 1 — listCharacters cache + multi-room
description: Two small changes that lift the practical character cap from ~100s to ~thousands stored / ~hundreds active without touching the storage backend. Bridge cache + Colyseus room sharding.
status: todo
order: 205
epic: agent-sandbox
---

The current single-bridge / single-room design works fine at the scale we've tested (a few dozen characters). Two specific bottlenecks emerge before the storage backend itself becomes a problem:

1. **`listCharacters()` is the hot path.** The frontend polls `GET /characters` every 5 seconds. Each scan is O(N) synchronous file reads (`readdirSync` → for each entry: `nip19Decode` + `readFileSync(agent.json)` + `readFileSync(sk.hex)` + `JSON.parse`). At 1,000 characters this is ~50–200 ms per scan — noticeable; at 10,000 it's 500 ms–2 s and the bridge stalls.

2. **Colyseus rooms cap at 20 clients.** `SandboxRoom.maxClients = 20`. Hundreds of agents in one shared room is impossible today, and even if we raised the cap, presence updates are O(N²) per move — visually chaotic and bandwidth-heavy.

This card fixes both without changing the on-disk storage format. SQLite migration is task #215.

## Deliverables

### Bridge — character cache

- `agent-sandbox/pi-bridge/character-store.js` — new module wrapping the existing filesystem reads.
  - `getCharacters()` returns a memoized `[Character]` array. First call populates from disk (today's logic). Subsequent calls return the in-memory cache.
  - `invalidateAll()` and `invalidateOne(pubkey)` for explicit busting.
  - Thread `saveCharacterManifest`, `createCharacter`, `deleteCharacter`, and the manifest-touching code paths (avatar generation, harness change, `rebaseStaleAvatarUrls`) through the cache so the API stays consistent.
- `app.get("/characters")` calls `getCharacters()` instead of the existing `listCharacters()` scan.
- Cache shape mirrors today's serialized output (no API change). Internal layout can be a `Map<pubkey, Character>` for O(1) lookup; `findAgentByPubkey` and `activeRuntimeForCharacter` benefit too.
- On startup, do one full scan to seed the cache (no different from today's first call). Subsequent reads are RAM-only.
- Add a small `etag` or `version` counter incremented on every invalidate; expose at `/characters` so a future client could skip downloads when nothing changed.

### Bridge — soft active-runtime cap

- New env `MAX_ACTIVE_AGENTS` (default 50). When `agents.size` reaches this and a spawn arrives, return 503 with a clear message ("active runtime cap reached; existing agents reaped after AGENT_IDLE_TIMEOUT_MS").
- Tune `AGENT_IDLE_TIMEOUT_MS` lower (5 min → 2 min) by default so turnover is faster and zombie sessions don't hold seats.
- These together let "thousands stored, ~50 active at any moment" feel responsive on a single bridge instance.

### Room — multi-room sharding

Two routes; pick one:

**Path A — auto-distribute into N rooms of M.** The room-server picks a room with capacity when an agent joins. Frontend joins the same room. Single room name (`sandbox`), Colyseus's built-in matchmaker handles instances. Most invisible to users.

- `SandboxRoom.maxClients = 50` (raised from 20)
- Drop `filterBy(["roomName"])` so Colyseus matchmaker creates new room instances when current ones fill, instead of routing everyone to the first matching `roomName`
- Frontend `useSandboxRoom` doesn't need to care — it just calls `joinOrCreate("sandbox", { roomName: "sandbox" })` and gets whichever instance has space
- Caveat: agents can't see each other across instances. Acceptable trade for crowd-scale; future work is real cross-instance presence

**Path B — explicit room selector in UI.** User picks `sandbox`, `lounge`, `playground`, etc. Each is its own room with up to 50 clients. Visible and controllable.

- Add a small "Room" select to `SandboxSettings` next to Brain
- `Sandbox.spawnBody` sends `roomName` from the selector
- `useSandboxRoom` keys on `roomName` so observers and agents land in the same instance
- Frontend roster shows current room only

Recommendation: **A first** (zero UX change, immediate scale relief), **B later** if/when users want themed rooms. They're not exclusive.

## Acceptance

- 1,000 character manifests on disk + frontend polling `/characters` at 5 s: response time stays under 50 ms (vs ~200 ms today). Verified with `time curl /characters` and a synthetic seed script that materializes 1,000 characters.
- 60 agents spawned across the same room name end up split across 2 room instances, each ~30 clients. Both groups see their own agents move/post normally; cross-instance is intentionally not bridged.
- Spawning the 51st active agent on a bridge with `MAX_ACTIVE_AGENTS=50` returns 503; reaping an idle one frees the slot.
- Existing tests still pass (38/38). Add 3–4 new tests around the cache: hit count, invalidation on save, returns same shape as the old scan.

## Non-goals

- Replacing the storage backend (that's #215).
- Cross-instance roster (agents in room A seeing agents in room B) — punt to a later task. The matchmaker spreading agents into separate instances is the v1; richer "shared world view" can come later if it matters.
- Migrating to a different Colyseus topology (multiple `room-server` containers) — single Railway instance handles many rooms easily; horizontal scaling is task #215+.

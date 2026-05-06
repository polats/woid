# Shelter — agent behaviour & offline data

Plan for Shelter's agent layer: local-first state, deterministic
schedules instead of LLM ticks, and a debug menu for adding agents
during dev. Companion to
[shelter-data-backend.md](./shelter-data-backend.md), which covers
character assets and rendering.

Research underpinning this plan:
[agent-behavior-fs-castles.md](../research/agent-behavior-fs-castles.md).

## Goal

Shelter agents should:

1. Persist on the device, not the colyseus server. Cloud sync is a
   future stub, not a launch dependency.
2. Move and act inside rooms via deterministic schedules. The LLM is
   reserved for authored events / dialogue, not per-tick polling.
3. Be addable / removable through a developer-only debug menu so we
   can test scenarios without spinning up the sandbox.

## Locked-in defaults

- **Time scale**: 1 real second = 1 sim minute. So 1 real minute =
  1 sim hour, and one in-game day takes 24 real minutes.
- **Offline cap**: 12 sim hours (720 sim minutes). On resume, sim
  time advances by `min(720, elapsed)`. Closing the app doesn't
  punish the player.
- **Foreground-only consequence ticks**: bad things (event firing,
  needs decay) only happen while the tab is foregrounded; matches
  Fallout Shelter's pattern.
- **Schedules to start**: a single `worker` template. Manager,
  visitor, etc. land later.
- **Debug menu**: dual-source — local dummy templates always
  available; bridge `/characters` shown when reachable.
- **Per-agent `llmEnabled` flag**: future-proofs A/B testing
  deterministic-only vs LLM-augmented agents in the same vault.

## Data model

A single JSON blob in `localStorage` under key `woid.shelter.v1`.
Promote to IndexedDB when state outgrows ~5 MB.

```ts
{
  version: 1,
  lastTickWallClock: number,   // ms, for closed-form catch-up
  simMinutes: number,          // monotonic since vault founded
  rooms: {
    [roomId]: {
      upgradeLevel: number,
      productionTimer: number, // sim minutes until next batch
    }
  },
  agents: {
    [agentId]: {
      id: string,
      name: string,
      pubkey?: string,         // hex; links to bridge character
      llmEnabled: boolean,
      traits: { focus, social, stamina, ... },
      scheduleId: string,      // 'worker' | future templates
      assignment: { roomId, role } | null,
      state: 'idle' | 'walking' | 'working' | 'rest' | 'event',
      stateSince: number,      // simMinutes when state entered
      pos: { roomId, localU, localV }, // u/v ∈ [0,1] inside the room
      relations: { parents: string[], partner?: string, children: string[] },
      createdAt: number,       // simMinutes
    }
  },
  events: [],                  // authored events; Phase 5
}
```

## Two clocks

- **Wall clock** — `lastTickWallClock` is a JS `Date.now()` value.
  Used only on resume to compute elapsed real time.
- **Sim minutes** — monotonic integer minutes since vault founded.
  Drives schedules and timers. Conversion:
  `simMinutes += min(OFFLINE_CAP_MIN, (now − lastTickWallClock) / 1000)`.

The conversion is `1 real second → 1 sim minute`; the integer
`simMinutes` field remains the canonical reference.

## Schedule layer (the non-LLM behaviour)

A schedule is a small array of slots:

```js
const worker = [
  { from: '00:00', action: 'rest',   roomId: 'living-1'     },
  { from: '07:00', action: 'work',   roomId: 'office-1'     },
  { from: '12:00', action: 'social', roomId: 'break-room-1' },
  { from: '13:00', action: 'work',   roomId: 'office-1'     },
  { from: '18:00', action: 'social', roomId: 'wellness-1'   },
  { from: '21:00', action: 'rest',   roomId: 'living-1'     },
]
```

`resolveAgentState(agent, simMinutes)` is a pure function: given the
current sim time, return the slot the agent should be in. If
different from `agent.assignment`, the tick loop transitions the
agent through `walking` to the new room. Inside a room, the agent's
deterministic sub-position is picked by `(action, agentId)` so
agents fan out across stations.

No LLM in this loop. Schedules are templates keyed by `scheduleId`
on the agent.

## Movement

Phase 1 keeps it dead simple: `walking` is a fixed 30-second timer
that fades the agent out at the source room, and fades them in at
the destination. No corridors, no path-finding.

Real walking (corridor overlay, A* on the room graph) is deferred —
the renderer already knows about rooms, so adding it later is local.

## Sync stub

A pluggable `Sync` interface, no-op for now:

```ts
interface ShelterSync {
  push(snapshot): Promise<void>   // outbound
  pull(): Promise<snapshot | null> // inbound
}
```

Phase 1 wires a `LocalOnlySync` that persists to `localStorage` and
has empty push/pull. When we add cloud, we drop in a
`BridgeSync` implementation without touching call-sites.

## Debug menu

A floating "DEV" button at the top-right of the phone screen,
visible only when `import.meta.env.DEV`. Clicking opens a panel:

- **Add agent** — pick from bridge `/characters` (if reachable) or
  a built-in dummy roster. Choose a starting room. Insert into the
  store; agent appears in the next render.
- **Remove agent** — list current agents with a remove button.
- **Clear all** — wipes `woid.shelter.v1`.
- **Fast-forward 1h** — adds 60 sim minutes to advance schedules.
- **Dump JSON** — `console.log` of the full snapshot for debugging.

## Decoupling from colyseus

`ShelterStage3D` switches its presence-sync effect from
`useSandboxRoom` to `useShelterStore`. The avatar factory's
`spawn(pubkey)` API is unchanged — only the writer of the agent
list flips from server-broadcast to local store.

Sims keeps using colyseus. The two views now read different
sources, which is the intended split: Sims is the live multi-user
sandbox; Shelter is the player's local game.

## Phasing

1. **Store + clock + schema** — `src/lib/shelterStore/`,
   `useShelterStore` hook. Persisted JSON, simTime advance with
   offline cap, sync-stub. No UI yet.
2. **Schedule resolver** — pure `resolveAgentState`, foreground
   tick loop. Asserts only — agents don't render from this yet.
3. **Wire ShelterStage3D to the store** — replace the
   `useSandboxRoom` consumer; avatars spawn from store entries,
   position derived from resolver.
4. **Debug menu** — floating button + panel.
5. **Authored event templates** — 4–5 starter templates with trait
   gates and per-template cooldowns. LLM wiring deferred.

## Out of scope (for now)

- Real corridor pathing / inter-room walking animation.
- Cloud sync server.
- Per-agent need decay (hunger, mood, etc.). Timers stay on rooms.
- LLM event content. Templates ship with placeholder copy.

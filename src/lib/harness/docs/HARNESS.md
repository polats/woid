# HARNESS

A small library of character-agnostic agent primitives. Drop it into your game; characters get a perception bus, decay-based needs, event-driven moodlets, verbatim memory, and a pluggable Brain interface.

This is the public contract. See [integrating.md](integrating.md) to write your own adapter in 30 minutes. See [docs/design/agent-harness.md](../../../../docs/design/agent-harness.md) for the design plan and [docs/research/agent-harness-2026.md](../../../../docs/research/agent-harness-2026.md) for the research.

## Four interfaces

The full type definitions are in [src/lib/harness/types.js](../types.js). The shapes:

### Observation

What a character sees this tick.

```js
{
  selfId: 'dupe-1',
  tick: 412,
  trigger: { kind: 'heartbeat' },
  perception: [ /* PerceptionEvent[] — typed event log delta */ ],
  needs:    { energy: 42, food: 60 },     // optional
  moodlets: [ /* harness moodlets — optional */ ],
  traits:   [ 'brave' ],                   // promoted, read-only — optional
  game:     { /* game-specific blob */ },  // escape hatch
}
```

`game` is `Record<string, unknown>`. Your adapter populates it lazily — utility brains don't need it; LLM brains usually do.

### Brain

Produces actions from an observation. Pluggable per character per moment.

```js
const brain = createUtilityBrain({ id, candidates, scorers, topK, fallback })
const actions = await brain.step(observation)
// actions = [ { verb: 'mine', args: { x: 2, y: 4 } } ]
```

Reference brains in [impls/brains/](../impls/brains): `UtilityBrain`, `DeterministicBrain`. The Sims smart-object utility pattern + the Dave Mark utility-theory talks.

### Verb

A game-registered action. The harness ships zero verbs by default — your game declares its own.

```js
{
  name: 'mine',
  args: {
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
  },
  prompt: 'Mine ore from a deposit at (x, y).',
  handler: (actor, args, world) => [
    { kind: 'mutate', apply: (w) => { /* mutate world */ } },
    { kind: 'perceive', target: '*nearby*', event: { kind: 'colony:ore_mined', ts: Date.now() } },
  ],
}
```

Handler returns `Effect[]`. Two kinds: `mutate` (world state change) and `perceive` (emit a perception event). Moodlet emissions and action rejections are perceive events with kind `moodlet_added` / `action_rejected`.

### GameAdapter

The one interface a new game implements.

```js
const adapter = {
  observe(characterId, world, tick) { /* return an Observation */ },
  schedule(world, tick) { /* return [characterId, ...] */ },
  verbs: [ /* Verb[] */ ],
  identity: createMemoryIdentityStore(),
}
```

`observe` builds the Observation. `schedule` decides who gets a brain tick this frame (cheap; runs hot).

## Flow

```
       game tick
           │
           ▼
   adapter.schedule(world, tick)  ─►  [dupeId, …]
                                       │
              for each dupeId:         │
                                       ▼
                       adapter.observe(id, world, tick)
                                       │
                                       ▼ Observation
                            brain.step(obs)
                                       │
                                       ▼ Action[]
                       resolve verb handlers,
                       apply Effects,
                       broadcast perception events
                                       │
                                       ▼
                           next observation
```

See [`src/lib/colony/adapter.js`](../../colony/adapter.js) for a complete reference implementation against `src/lib/colony/world.js`.

## What the harness gives you

The cross-cutting state primitives so you don't have to write them:

- **`perception.js`** — typed event ring buffer per character. `appendOne`, `broadcastTo`, `eventsSince`. Defaults to 50 events per buffer.
- **`needs.js`** — decay axes (defaults: `energy`, `social`) with threshold-crossing events and a 4-band wellbeing label. Replace axes per game via the existing config object.
- **`moodlets.js`** — event-driven affect, mood-band aggregation, pluggable persistence (in-memory, localStorage, custom). Browser-safe.
- **`memory.js`** — verbatim past-scene injection for LLM brains. No summarization (deliberate — see research).

These four modules are the same character logic that powers the Sims sandbox in pi-bridge. The Node version persists JSONL; this library persists to localStorage or in-memory. Same API.

## Three escape hatches

1. **`game` in Observation** — your per-game state goes here. The harness never reads it; only your brain does.
2. **Custom `PerceptionEvent.kind`** — extend with `'colony:job_offered'`, `'shelter:shift_started'`, anything. Brains that don't recognize it ignore it.
3. **Custom Brain** — `UtilityBrain` is convenient; you can write any class that implements `step(obs) → Promise<Action[]>`. LLM brains plug in this way.

## What's deliberately not in here

- **No tile renderer** — your game owns rendering. Re-use `src/RoomMap.jsx` if a 2D CSS grid fits.
- **No universal world model** — each game owns its world.
- **No persistence framework** — only `IdentityStore` is pluggable here.
- **No multi-character coordination primitives** — compose via Verbs + perception events.

Next: [integrating.md](integrating.md) walks through writing your own adapter.

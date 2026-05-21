# Integrating a new game

You want to add agents to your game. The harness covers the cross-cutting stuff (perception, needs, moodlets, memory, the brain interface); you write a small adapter and a verb registry. Roughly 30 minutes from clone to working "Hello World" adapter.

For the four interfaces, see [HARNESS.md](HARNESS.md). For the canonical reference adapter, see [`src/lib/colony/`](../../colony).

## What you'll write

1. **`world.js`** — your game's state (pure data + helpers).
2. **`verbs.js`** — the actions your characters can take.
3. **`adapter.js`** — implements `GameAdapter`.
4. **A tick loop** — calls `adapter.schedule()`, then `adapter.observe()`, then `brain.step()`, then applies the actions.

## The 30-minute "Hello World"

Goal: one character on a screen who waves whenever they spawn.

### 1. State

```js
// src/lib/wave/world.js
export function createWorld() {
  return {
    tick: 0,
    characters: {
      ada: { id: 'ada', name: 'Ada', pos: { x: 0, y: 0 }, lastVerb: null },
    },
  }
}
```

### 2. Verbs

```js
// src/lib/wave/verbs.js
export const VERBS = {
  wave: {
    name: 'wave',
    args: {},
    prompt: 'Wave to whoever is around.',
    handler: (actor, _args, _world) => [
      { kind: 'mutate', apply: (w) => { w.characters[actor.id].lastVerb = 'wave' } },
      { kind: 'perceive', target: '*nearby*', event: { kind: 'speech', text: '👋', from_id: actor.id, ts: Date.now() } },
    ],
  },
  idle: {
    name: 'idle',
    args: {},
    prompt: 'Wait.',
    handler: (actor, _args, _world) => [
      { kind: 'mutate', apply: (w) => { w.characters[actor.id].lastVerb = 'idle' } },
    ],
  },
}
export const VERB_LIST = Object.freeze(Object.values(VERBS))
```

### 3. GameAdapter

```js
// src/lib/wave/adapter.js
import { createMemoryIdentityStore } from '../harness/impls/identity/MemoryIdentityStore.js'
import { VERB_LIST } from './verbs.js'

export function createWaveAdapter() {
  return {
    observe(id, world, tick) {
      const character = world.characters[id]
      return {
        selfId: id,
        tick,
        trigger: { kind: tick === 0 ? 'spawn' : 'heartbeat' },
        perception: [],
        game: { pos: { ...character.pos }, lastVerb: character.lastVerb },
      }
    },
    schedule(world, _tick) {
      return Object.keys(world.characters)
    },
    verbs: VERB_LIST,
    identity: createMemoryIdentityStore(),
  }
}
```

### 4. Brain

Use the shipped `DeterministicBrain` — it returns a fixed action list.

```js
import { createDeterministicBrain } from '../harness/impls/brains/DeterministicBrain.js'

const brain = createDeterministicBrain({
  id: 'wave-brain',
  actions: (obs) => obs.trigger.kind === 'spawn'
    ? [{ verb: 'wave', args: {} }]
    : [{ verb: 'idle', args: {} }],
})
```

For richer behavior, swap in `UtilityBrain` — see [`src/lib/colony/brain.js`](../../colony/brain.js).

### 5. Wire the tick

```js
// src/views/Wave.jsx (sketch)
import { createWorld } from '../lib/wave/world.js'
import { createWaveAdapter } from '../lib/wave/adapter.js'
import { VERBS } from '../lib/wave/verbs.js'
import { createDeterministicBrain } from '../lib/harness/impls/brains/DeterministicBrain.js'

const world = createWorld()
const adapter = createWaveAdapter()
const brains = new Map()  // id → Brain

setInterval(async () => {
  world.tick += 1
  for (const id of adapter.schedule(world, world.tick)) {
    let brain = brains.get(id)
    if (!brain) {
      brain = createDeterministicBrain({ id: `wave-${id}`, actions: [{ verb: 'wave', args: {} }] })
      brains.set(id, brain)
    }
    const obs = adapter.observe(id, world, world.tick)
    const actions = await brain.step(obs)
    for (const a of actions) {
      const v = VERBS[a.verb]
      if (!v) continue
      const effects = v.handler(world.characters[id], a.args, world)
      for (const eff of effects) {
        if (eff.kind === 'mutate') eff.apply(world)
        // (perceive events would feed a perception bus; this Hello World skips it)
      }
    }
  }
}, 250)
```

Render with [`src/RoomMap.jsx`](../../../RoomMap.jsx) or any 2D tile component, reading `world.characters` to position avatars.

That's the loop. Everything else is filling out richer state + scorers.

## Steps to a real game

Once Hello World runs, layer in:

| Add | Reference |
|---|---|
| Multiple verbs with arg schemas | [`src/lib/colony/verbs.js`](../../colony/verbs.js) |
| Per-character needs (decay over time) | [`src/lib/harness/needs.js`](../needs.js) |
| Moodlets driven by events + a pluggable persistence backend | [`src/lib/harness/moodlets.js`](../moodlets.js) |
| Perception ring buffer with interest management | [`src/lib/harness/perception.js`](../perception.js), [`src/lib/colony/loop.js`](../../colony/loop.js) |
| Utility-AI scoring with multi-axis considerations | [`src/lib/colony/utility.js`](../../colony/utility.js) |
| Local-first save state | [`src/lib/colony/store.js`](../../colony/store.js) |
| Foreground tick loop with visibility pause | [`src/hooks/useColonyTick.js`](../../../hooks/useColonyTick.js) |
| Sidebar route in the woid shell | `src/App.jsx` (search for `'colony'`) |

Colony is the canonical reference. Copy `src/lib/colony/` into `src/lib/<yourgame>/`, rename, change the world model + verbs, and you have a second game.

## When you need an LLM brain

The harness's reference brains don't call any LLM. For an LLM brain, plug your own implementation in:

```js
// src/lib/wave/llm-brain.js
export function createLLMBrain(opts) {
  return {
    id: opts.id,
    async step(obs) {
      // 1. Build a prompt from obs (use opts.formatObservation if you want)
      // 2. Call your LLM via your preferred SDK
      // 3. Parse the response into [{ verb, args }]
      // 4. Return the action list
    },
  }
}
```

The harness doesn't pre-pick a model provider. For Sims-style LLM brains we wire `@mariozechner/pi-coding-agent` and the Claude Agent SDK through pi-bridge; for solo games like Colony you can call a local on-device model (e.g. Gemma via the existing Capacitor plugin). The Brain interface doesn't care.

## When to depart from these patterns

If a pattern in the reference adapter doesn't fit your game, **fork it**. The harness contract is just the four interfaces. Everything in `colony/` is one implementation; nothing forces yours to look the same.

The two things you should not invent your own version of:

1. **The Brain contract** — `step(obs): Promise<Action[]>`. Stays the same so brains are swappable.
2. **The Effect taxonomy** — `mutate` and `perceive`. Stays the same so the perception bus + GM stay legible.

Everything else is yours.

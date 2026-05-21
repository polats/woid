# woid harness

A small library of character-agnostic agent primitives that woid games (Sims, Shelter, Colony) and external OSS adopters can build on.

See **[docs/design/agent-harness.md](../../../docs/design/agent-harness.md)** for the architectural plan and **[docs/research/agent-harness-2026.md](../../../docs/research/agent-harness-2026.md)** for the research that justified each choice.

## Modules

- `perception.js` — typed perception event ring buffer per character. Speech, movement, presence, action rejections, scene transitions, need crossings, mood changes, storyteller cues.
- `needs.js` — decay axes (default `energy`, `social`) with threshold-crossing events and a 4-band wellbeing label.
- `moodlets.js` — event-driven affect (event tags + weight + duration → mood band). Browser-safe; pluggable persistence (in-memory, localStorage, custom).
- `memory.js` — verbatim past-scene injection for LLM brains. No summarization.
- `types.ts` — the four canonical interfaces (Observation, Brain, Verb, GameAdapter). See [HARNESS.md](docs/HARNESS.md).
- `impls/brains/` — reference brains (`UtilityBrain`, `DeterministicBrain`).
- `impls/identity/` — reference IdentityStores (`MemoryIdentityStore`).

## Convergence with pi-bridge

The same four core modules live in `agent-sandbox/pi-bridge/`. The Node implementation in pi-bridge persists to JSONL on disk; this library persists in-memory or to localStorage. Both satisfy the same API. They will converge during the deferred "pi-bridge consumes Brain interface" hook (plan §7).

## Quick start

```js
import { createMoodletsTracker, createLocalStoragePersist } from './moodlets.js'

const moodlets = createMoodletsTracker({
  persist: createLocalStoragePersist({ namespace: 'woid.mygame.moodlets.v1' }),
})

moodlets.emit('dupe-1', {
  tag: 'breaker_tripped',
  weight: -5,
  reason: 'the breaker tripped during her shift',
  source: 'environment',
  duration_ms: 30 * 60 * 1000,
})

const { mood, band, breakdown } = moodlets.aggregate('dupe-1')
console.log(band)  // 'steady', 'lousy', 'breaking', or 'cheerful'
```

See [docs/integrating.md](docs/integrating.md) for the full adapter pattern.

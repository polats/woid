---
name: Harness — define the four interfaces and reference brains
description: Write src/lib/harness/types.ts with the four interfaces (Observation, Brain, Verb, GameAdapter) and ship two reference brains (UtilityBrain, DeterministicBrain) plus MemoryIdentityStore. No game uses them yet; this lands the contracts Colony will implement against.
status: done
order: 480
epic: harness
depends_on: [470]
---

Phase 1 of the agent harness plan. See **[docs/design/agent-harness.md §3](../docs/design/agent-harness.md#3-the-four-interfaces)** for the canonical type definitions. Research backing each interface choice is in [docs/research/agent-harness-2026.md §6](../docs/research/agent-harness-2026.md#6-architectural-decisions).

The four interfaces are the plug-in surface for external games adopting the harness. Six were drafted originally; collapsed to four after an overengineering audit (the IdentityStore beyond a name lookup, and the Controller as a separate type, both deferred). Earlier in-pi-bridge harness work in [#135](135-agent-sandbox-harness-abstraction.md) defined a narrower `Harness` interface; this card generalizes it.

## Deliverables

- `src/lib/harness/types.ts` (or `.d.ts` if pure JS preferred) — the four interfaces verbatim from [docs/design/agent-harness.md §3](../docs/design/agent-harness.md#3-the-four-interfaces):
  - `Observation`, `Trigger`, `PerceptionEvent`
  - `Brain`, `Action`
  - `Verb`, `ArgSchema`, `Effect`
  - `GameAdapter`
  - `PortableIdentity`, `IdentityStore` (sketched — the BYO-agent surface area is commented but not implemented)
- `src/lib/harness/impls/brains/UtilityBrain.js` — utility-scoring brain. Public API: `createUtilityBrain({ id, scorers, topK })`. Each `scorer(verb, args, observation) → number` contributes; top-K winners become the action list. Reference implementation of the Utility AI pattern from [docs/research/foundational-ai-patterns.md](../docs/research/foundational-ai-patterns.md).
- `src/lib/harness/impls/brains/DeterministicBrain.js` — emits `[{ verb: 'idle', args: {} }]` for any trigger. Smoke-test brain.
- `src/lib/harness/impls/identity/MemoryIdentityStore.js` — in-memory IdentityStore. The only one needed for Phase 2 (Colony).
- `src/lib/harness/impls/index.js` — re-exports.
- Inline JSDoc on every exported interface.

## Acceptance

- `npx tsc --noEmit src/lib/harness/types.ts` passes (or JSDoc lints clean if going TS-free).
- Unit smoke (can be inline in the module, no test framework needed):
  - `DeterministicBrain.step({} as Observation)` resolves to `[{ verb: 'idle', args: {} }]`.
  - `UtilityBrain` with two scorers returns the higher-scoring verb first.
- The four interfaces compile when imported from `src/lib/colony/adapter.js` stub (created in [#490](490-colony-game-scaffold.md)).
- `MemoryIdentityStore.save()` + `load()` round-trip a `PortableIdentity` record.

## Non-goals

- Implementing a `LLMBrain` in this card. Pi-bridge already has the LLM-driving machinery; a Brain adapter around it lands later (deferred §7 of the plan).
- A `Controller` interface. Cost-gating logic lives inside Brain implementations for now; if multiple Brains need shared gating, extract then.
- Full IdentityStore semantics (verify, rateLimitState). Comment the BYO-agent extensions; don't ship them.
- Wiring the interfaces into Sims (pi-bridge). That's a deferred hook (§7).

## Risk notes

- The `Observation.game` escape hatch is intentionally `Record<string, unknown>`. Resist the temptation to type it generically (`Observation<G>`) — the per-game typing happens in each game's adapter, not in the harness contract.
- `Effect` collapsed from four variants to two (`mutate`, `perceive`). Moodlet emission and action rejection are now `perceive` events that the moodlets tracker / GM subscribe to. This matches the existing event-bus pattern in [perception.js](../agent-sandbox/pi-bridge/perception.js); the migration target is convention, not code change.
- The `Brain` interface is async (`Promise<Action[]>`). `UtilityBrain` is synchronous internally; it returns `Promise.resolve(actions)`. Keep the interface async to leave room for LLM brains.

## Why before Colony

Colony's adapter ([#490](490-colony-game-scaffold.md)) implements `GameAdapter` and consumes `UtilityBrain`. Both must exist before that work can start. ~0.5 day estimated.

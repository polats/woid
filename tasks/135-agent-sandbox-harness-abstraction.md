---
name: Harness abstraction — pluggable brains (pi, direct, external, hermes…)
description: Extract a small Harness interface so the bridge's turn loop doesn't know or care how the LLM gets called. Wrap existing pi-pool as the first implementation without changing behavior.
status: done
order: 135
epic: agent-sandbox
---

Today the bridge is tightly coupled to pi: `ensurePiHandle`, `pi-pool.js`, skill shell scripts, `/internal/post` loopback, session JSONL parsing. Pi is a coding agent (bash/read/write/edit/grep/find/ls) — our sandbox characters only use `say`/`move`/`state`, so most of pi's machinery is unused while still adding complexity.

Extract a `Harness` interface that models "take a turn, produce actions" and wrap current pi-pool behind it. No behavioral change — this is pure refactor that unlocks alternate brains (direct SDK call in #145, external HTTP in #150, future Hermes / Claude Agent SDK / etc).

## The interface

```ts
interface Harness {
  start(opts: StartOpts): Promise<void>
  turn(userTurn: string): Promise<TurnResult>
  stop(): Promise<void>
  onEvent?: (ev: HarnessEvent) => void
}

type Action =
  | { type: 'say',   text: string }
  | { type: 'move',  x: number, y: number }
  | { type: 'state', value: string }

interface TurnResult {
  actions: Action[]
  thinking?: string
  usage?: { input: number, output: number, cost?: number }
  error?: string
}

interface StartOpts {
  agentId: string
  systemPrompt: string
  provider: string
  model: string
  sessionPath?: string
  env?: Record<string, string>
  cwd?: string
}

interface HarnessEvent {
  kind: 'turn_start' | 'think' | 'action' | 'turn_end' | 'lifecycle'
  // per-harness detail; inspector renders what's there
}
```

The bridge's turn loop becomes:

```js
const result = await harness.turn(userTurn)
for (const action of result.actions) {
  if (action.type === 'say')   sendSay(agentId, action.text)
  if (action.type === 'move')  moveAgent(agentId, action.x, action.y)
  if (action.type === 'state') saveCharacterManifest(pubkey, { state: action.value })
}
```

No harness ever touches Colyseus, Nostr, or the filesystem directly — the bridge does that based on the returned actions.

## Deliverables

- `agent-sandbox/pi-bridge/harnesses/types.js` — interface + JSDoc types (plain JS with JSDoc; avoids introducing TypeScript for a single file).
- `agent-sandbox/pi-bridge/harnesses/pi.js` — **PiHarness**. Wraps the current `pi-pool.js` + the skill-script loopback, but exposes the new interface. Internally still spawns pi in RPC mode; the "actions" come from parsing post.sh invocations as `say` actions (or, later, pi-native tool-use if we add `say`/`move`/`state` as first-class pi tools).
- `agent-sandbox/pi-bridge/harnesses/index.js` — `selectHarness(name) → Harness` factory. Known names: `pi` (now), `direct` (#145), `external` (#150).
- Refactor `runPiTurn` / `ensurePiHandle` in `server.js` to go through the harness:
  - On spawn: `harness = selectHarness(character.harness || 'pi'); await harness.start(...)`
  - On turn: `const result = await harness.turn(userTurn); executeActions(result)`
  - On stop: `await harness.stop()`
- Character manifest gains optional `harness` field (default `"pi"` for back-compat).
- `POST /agents` accepts optional `harness` override at spawn time.
- `/health` keeps its pool + cooldowns fields (PiHarness exposes its own internal snapshot through the same shape).
- Rate-limiter hooks stay where they are — harnesses report errors up, bridge records them and gates future turns.

## Acceptance

- Running locally, every existing test path works identically to before: spawn agent, chat, move, stop — all through `PiHarness`. No regression to Phase 1 behavior.
- `GET /characters` and `GET /agents` expose `harness` field.
- Dropping `harness: "pi"` in `POST /agents` body produces the same result as omitting it (default wiring).
- Reading `server.js` is visibly shorter — the turn loop is ~20 lines instead of ~80, and the coupling to pi-specific event shapes is gone from the top-level code.
- Existing inspector Live tab still renders pi events (PiHarness emits them via onEvent unchanged).

## Non-goals

- New harnesses (those are #145, #150).
- Removing pi-specific code — PiHarness still houses it, just encapsulated.
- Changing the user turn or system prompt shape — buildContext stays as-is; harnesses consume it.

## Why before #140

The scheduler's natural abstraction is "one more actor to schedule" — not "one more pi process to coordinate with." If #140 lands on raw pi-pool first, it'll need a small refactor once the harness interface exists. Doing #135 first makes #140 harness-agnostic on day one, which also makes #150 (external harness as a scheduled actor) trivial. Order ideally: 135 → 140 → 145 → 150.

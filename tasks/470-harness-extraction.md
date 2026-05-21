---
name: Harness — extract reusable modules from pi-bridge into src/lib/harness/
description: Relocate perception, moodlets, needs, memory from agent-sandbox/pi-bridge/ into src/lib/harness/ as the foundation for the cross-game harness. Make them runtime-neutral so the browser (Colony) and Node (pi-bridge) can both import them. No behavior change; pi-bridge keeps working via re-exports.
status: done
order: 470
epic: harness
---

Phase 0 of the agent harness plan. See **[docs/design/agent-harness.md](../docs/design/agent-harness.md)** for full context. Research justifying this work is in [docs/research/agent-harness-2026.md](../docs/research/agent-harness-2026.md).

The agent harness is currently split across `agent-sandbox/pi-bridge/*.js` (server-side Node, Sims-coupled) and `src/lib/shelterStore/` (client-side, Shelter-specific). To support a third game (Colony — see [#490](490-colony-game-scaffold.md)) and a BYO-agent direction, the character-agnostic modules need to live in `src/lib/harness/` and be importable from both runtimes.

This is pure relocation + a small I/O abstraction. No interface changes, no behavior changes.

## Deliverables

- `src/lib/harness/perception.js` — copy of [`agent-sandbox/pi-bridge/perception.js`](../agent-sandbox/pi-bridge/perception.js), unchanged behavior. Already runtime-neutral (in-memory ring buffer only).
- `src/lib/harness/moodlets.js` — copy of [`moodlets.js`](../agent-sandbox/pi-bridge/moodlets.js). The `fs` dependency is already pluggable via the `opts.fs` constructor argument; verify a browser-safe stub (in-memory or localStorage-backed) compiles cleanly.
- `src/lib/harness/needs.js` — copy of [`needs.js`](../agent-sandbox/pi-bridge/needs.js). Already pure (no I/O).
- `src/lib/harness/memory.js` — copy of [`memory.js`](../agent-sandbox/pi-bridge/memory.js). Already pure.
- `src/lib/harness/README.md` — one paragraph: "these modules are the substrate the harness builds on; the four interfaces (Observation, Brain, Verb, GameAdapter) land in [#480](480-harness-interfaces.md)."
- `agent-sandbox/pi-bridge/perception.js`, `moodlets.js`, `needs.js`, `memory.js` become **re-export shims** during the transition. They import from `src/lib/harness/` and re-export. Existing pi-bridge code paths don't change their imports.

## Acceptance

- `npm run agent-sandbox:smoke` passes unchanged.
- `npm run dev` opens Shelter and Sims sandbox without regressions.
- A Vite import of `src/lib/harness/moodlets.js` from a React file compiles (use `createMoodletsTracker({ fs: stubFs })`).
- `agent-sandbox/pi-bridge/server.js` and all other pi-bridge files compile against the shim re-exports without changes.
- Module-level smoke: `node -e "import('./src/lib/harness/perception.js').then(m => console.log(Object.keys(m)))"` lists the exported APIs.

## Non-goals

- Migrating pi-bridge to consume the four new interfaces from [#480](480-harness-interfaces.md). The interfaces land separately; this card is pure relocation.
- Deleting the pi-bridge shims. Deletion is a follow-up once nothing in pi-bridge depends on them by path.
- Refactoring the relocated modules. Behavior is byte-identical.
- Touching Shelter (`src/lib/shelterStore/`). Shelter doesn't use these modules yet; that's a deferred hook in §7 of the plan.

## Risk notes

- `moodlets.js` writes JSONL to `$WORKSPACE/moodlets/<pubkey>.jsonl`. The browser has no workspace. Verify the constructor's `opts.fs` injection works with a stub like `{ existsSync: () => false, mkdirSync: () => {}, readFileSync: () => '', writeFileSync: () => {}, readdirSync: () => [] }`. The browser stub uses localStorage instead of files.
- Pi-bridge imports `node:fs`, `node:path`, `node:crypto` in `moodlets.js`. Browser-side, those imports must be conditionally guarded so Vite doesn't break. Options: dynamic import at runtime gated by `typeof window`, or a separate `moodlets.browser.js` entry. The dynamic-import option is preferred because it keeps one file.
- The shim re-exports must be tested for circular-import behavior. Pi-bridge files might `require()` from each other in patterns that the new layout could break. Run `npm run agent-sandbox:smoke` after each shim is added, not at the end.

## Why this card first

Phase 0 unblocks every other phase. Without the modules in `src/lib/harness/`, Colony ([#490](490-colony-game-scaffold.md)) can't import them; the four interfaces ([#480](480-harness-interfaces.md)) can't reference them; the docs ([#510](510-colony-sidebar-and-docs.md)) have nowhere to point. Estimated 1 day.

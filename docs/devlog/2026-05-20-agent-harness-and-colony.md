# 2026-05-20 — agent harness library + Colony demo game

Built the cross-game agent harness (`src/lib/harness/`) and the Colony
demo game (`src/lib/colony/` + `src/views/Colony.jsx`) end-to-end. The
plan in [docs/design/agent-harness.md](../design/agent-harness.md)
shipped with no scope changes — Phase 0 through Phase 4 closed in one
session.

Tasks closed: [#470](../../tasks/470-harness-extraction.md),
[#480](../../tasks/480-harness-interfaces.md),
[#490](../../tasks/490-colony-game-scaffold.md),
[#500](../../tasks/500-colony-utility-ai.md),
[#510](../../tasks/510-colony-sidebar-and-docs.md),
[#520](../../tasks/520-colony-skill-bundle.md).

End state:
- **`src/lib/harness/`** ships `perception.js`, `needs.js`, `memory.js`,
  `moodlets.js`, the four interface typedefs in `types.js`, and three
  reference impls (`UtilityBrain`, `DeterministicBrain`,
  `MemoryIdentityStore`).
- **Colony** lives at `#/colony` with a feature flag in
  `woid.config.json`. 4 dupes autonomously mine ore, eat at the
  kitchen, sleep at beds. Zero LLM cost.
- **Tests**: `e2e/colony.spec.ts` has 3 specs — render, autonomous
  mining, debug-panel spawn/remove. All green.
- **Docs**: two harness onboarding pages (HARNESS.md, integrating.md)
  in `src/lib/harness/docs/`; per-game READMEs in `src/lib/harness/`
  and `src/lib/colony/`; top-level README updated; deferred
  BYO-agent layer documented at `docs/byoa.md`.

---

## Architectural decisions that landed differently than the plan

A few practical calls during implementation that the plan-level docs
should be read against.

### Two parallel `moodlets.js` files (one Node, one browser)

The plan called for relocating four pi-bridge modules into
`src/lib/harness/` with re-export shims left in pi-bridge. Three of
them (`perception`, `needs`, `memory`) were byte-identical copies. The
fourth, `moodlets.js`, used Node's `fs` / `path` / `crypto` at the
top of the file. Vite can't bundle those for the browser without
either a top-level dynamic-import hack (top-level await + eval-hidden
require) or a Vite-config alias for `node:*` modules.

Both options were uglier than what we shipped instead: the new
`src/lib/harness/moodlets.js` is a byte-functional port with a
**pluggable persistence backend**. The default is in-memory; the
browser uses `createLocalStoragePersist({ namespace })`. Pi-bridge's
own `moodlets.js` is untouched. Two implementations of the same API,
no Node imports leaking into Vite's graph.

Convergence is a deferred hook (§7 of the design doc, "Pi-bridge
consumes Brain interface") — when pi-bridge migrates to consume the
harness, both files collapse into one.

### `Effect` taxonomy collapsed to two variants

The plan drafted four `Effect` variants (`mutate | perceive | moodlet |
reject`). During implementation the two of them turned out to be sugar
for `perceive` with kind `moodlet_added` / `action_rejected` — exactly
what pi-bridge's existing perception bus already does. Shipped two
variants: `mutate` (world state change) and `perceive` (emit a
perception event). Moodlet emissions and action rejections become
typed perception events.

This matches docs/research/agent-harness-2026.md §6's "no premature
abstraction" line.

### Verb set adjusted from the spec

The Phase 2a task card sketched verbs `take_job`, `move_to`,
`deliver`, `eat`, `sleep`. The shipped verbs are `move_to`, `mine`,
`eat`, `sleep`, `idle`. The `take_job` indirection turned out to
double-translate the brain's decision; `mine(x, y)` as a direct verb
with an implicit teleport reads better in the inspector and avoids a
multi-tick state machine for the demo. `deliver` was dropped because
nothing in the v0 world receives resources. `idle` was added as the
canonical fallback the UtilityBrain returns when nothing scores.

### RoomMap got one new prop, otherwise reused as-is

`src/RoomMap.jsx` already does everything Colony's tile grid needs:
CSS-grid layout, occupant rendering with avatar, object glyphs per
tile, drag-and-drop, click-to-select. Added one optional `glyphFor`
prop (defaults to the existing built-in map) so Colony can show
`⛰️ 🛏️ 🍳 ▣` instead of Shelter's chairs and beds. Five-line patch.
Avoids ~250 LOC of a parallel ColonyMap.jsx.

The audit conclusion ("for Colony, reuse RoomMap and pass a
`glyphFor` override") was right.

### Colony view doesn't use the `game-mount` pattern

Shelter and Sims both use `<div className="game-mount" hidden={...}>`
because each owns a WebGLRenderer and stacking two contexts blows
through the browser's context cap. Colony uses CSS-grid 2D rendering
via RoomMap — no WebGL — so it's a plain conditional mount alongside
the other content views. Cheaper.

### Phase 4 skill bundle ships as documentation/template, not a wired runtime

The Phase 4 task card sketched a full BYO-agent layer:
`/colony/join` + `/colony/verb` + `/colony/perception` (SSE) +
signed-Nostr auth + bash scripts that hit the real API. Implementing
all of that would have meant a parallel server-side Colony state
(currently the game is browser-local), and the user explicitly said
"don't rewrite code that doesn't need to be written."

Shipped: the SKILL.md + references/strategy.md + scripts/take_job.sh
(placeholder body that documents the future API shape) + docs/byoa.md.
The **file convention is shipped**; the wire transport is the next
milestone, gated on the first real BYO-agent user signaling they want
to drive a dupe. Decision is documented in docs/byoa.md and in
[#520](../../tasks/520-colony-skill-bundle.md)'s body.

---

## Numbers

| Metric | Value |
|---|---|
| Total new files | 19 |
| Total modified files (existing code) | 4 (App.jsx, Sidebar.jsx, RoomMap.jsx, woid.config.json) |
| Total LOC new code (excl. docs) | ~1,200 |
| Total LOC docs | ~600 |
| Sims regression | none (per `npm run smoke` and home.spec.ts) |
| Shelter regression | none |
| Pi-bridge regression | none (pi-bridge files unchanged) |
| Time on the clock | one session, ~6 hours real |

## Test surface

- `npm run smoke` — passes 4/4
- `e2e/colony.spec.ts` — 3 specs, all green
  - Route loads, no console errors, 4 dupes render
  - Dupes autonomously mine ore (verifies `resources.ore > 0` after 4 sec)
  - Debug panel spawn/remove
- `e2e/home.spec.ts` — passes (verifies shell still mounts)

## Open follow-ups

The deferred-hooks section of the design doc lists six items by
activation trigger. None of them are urgent. The ones most likely to
become real:

- **Colony HTTP API** (Phase 4b) when the first BYO-agent player asks.
- **Lazy-materialized roster (Census)** when someone adds >8 dupes.
- **DF middle moodlet tier** when Shelter multi-day arcs hurt.
- **Pi-bridge → harness migration** when a non-pi LLMBrain ships.

The plan doc's §7 is canonical; the rest will track from there.

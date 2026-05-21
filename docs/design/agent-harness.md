# Agent harness — implementation plan

The plan for extracting a reusable agent harness from `agent-sandbox/pi-bridge/` and proving its portability with a new demo game (Colony — an Oxygen-Not-Included-flavored colony sim). Companion to [docs/research/agent-harness-2026.md](../research/agent-harness-2026.md), which records the research that justified each decision.

The promise this plan delivers: **a player running OpenClaw / Hermes / Claude Code can install a skill bundle, point their agent at a woid game, and their agent becomes a character in the world.** The architecture is reusable so external OSS adopters can ship their own games on the same substrate.

This doc is the source of truth for task cards `#470`–`#520`. Each card points back here for full context.

> **Phase 5 follow-up:** Phases 0–4 shipped the harness library and Colony, but only Colony actually consumes `src/lib/harness/` — Sims and Shelter remain on their own codepaths. The cross-world claim in §1 below is therefore partly aspirational.
>
> A Phase 5 was attempted (see [docs/design/world-registry.md](world-registry.md) — now **superseded**) introducing a `WorldRegistry` + tabbed overlay. It was reverted the same day in favor of a smaller lifecycle-focused harness: `src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`, surfaced through the existing `SandboxCards` drawer. The reverted Phase 5 is documented for history; the cross-world story is now told through drag-to-spawn, per-card per-world stop buttons, and a shared worlds legend. See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

---

## 1. Goals and non-goals

### Goals

1. **Cross-game portability.** Same harness powers Sims (multiplayer Colyseus sandbox), Shelter (solo localStorage idle/sim), and Colony (ONI-flavored colony sim). External games adopt by writing one adapter.
2. **BYO-agent positioning.** Players bringing OpenClaw, Hermes, Pi, Claude Code can join via a Skill bundle. MCP server exposes verbs; A2A Agent Card exposes NPCs.
3. **Performant by default.** Most characters in Colony never call the LLM (utility AI). The LLM path is opt-in per character and per moment.
4. **Documented.** Two short docs (`HARNESS.md`, `integrating.md`) + three working reference adapters (Sims, Colony, optionally Shelter) carry the convention.
5. **No overengineering.** Five days of work for the harness extraction + Colony demo. BYO-agent layers in incrementally on top.

### Non-goals (this plan)

- Migrating pi-bridge to consume the new interfaces (extract the modules, keep behavior).
- Forcing Shelter through the GameAdapter shape — Shelter has its own deterministic schedule and doesn't need the harness yet.
- A universal world model. Each game owns its world; the harness sees only Observations.
- BYO-agent ships as a follow-up phase, not as part of the initial 5 days.
- A2A inter-NPC routing inside woid — A2A is for external player-agents only.

### Out of scope entirely

- Universal renderer adapter; universal persistence framework; universal multi-game runtime; a Mesh framework with extension points.

## 2. Audience contract

Two distinct contracts:

- **For woid's own games (Sims, Shelter, Colony):** Identity is portable across the games (same Alice). Per-game state isn't. Same harness modules, same interfaces.
- **For external adopters (OSS):** A 6-interface plug-in surface + a 2-doc onboarding path + Colony as the reference greenfield adapter. Fork-friendly first; npm-publishable later if there's demand.

## 3. The four interfaces

Located in `src/lib/harness/types.ts` (or `.d.ts` if pure JS). Driven by the research in [docs/research/agent-harness-2026.md §6](../research/agent-harness-2026.md#6-architectural-decisions). Earlier draft had six; collapsed to four after the overengineering audit.

### Observation — what a character sees this tick

```ts
export type Observation = {
  selfId: string                    // opaque, game-defined
  tick: number                      // monotonic; ms-equivalent
  trigger: Trigger
  perception: PerceptionEvent[]     // typed event log delta since last tick
  needs?: Record<string, number>    // { energy: 42, stress: 68 }
  moodlets?: Moodlet[]              // from shared moodlets module
  traits?: string[]                 // PortableIdentity-promoted, read-only
  game: Record<string, unknown>     // game-specific blob; lazily built
}

export type Trigger =
  | { kind: 'spawn' }
  | { kind: 'heartbeat' }
  | { kind: 'perception', cause: PerceptionEvent['kind'] }
  | { kind: 'card', cardId: string }
  | { kind: 'player', verb: string }

export type PerceptionEvent = {
  kind: string                      // 'speech' | 'movement' | 'colony:job_offered'
  ts: number
  [field: string]: unknown          // kind-specific payload
}
```

`game` is the escape hatch — games extend with their own state without forcing premature universal typing. Build lazily; deterministic brains never read it.

### Brain — produces actions from an observation

```ts
export interface Brain {
  readonly id: string
  step(obs: Observation): Promise<Action[]>
  onAttach?(character: { id: string }): void
  onDetach?(character: { id: string }): void
}

export type Action = {
  verb: string                      // matches a registered Verb.name
  args: Record<string, unknown>
}
```

Pure: same observation in → same actions out (modulo Brain's internal state). Brain owns its memory; harness owns the event bus.

### Verb — game-registered action

```ts
export type ArgSchema = {
  type: 'string' | 'number' | 'boolean' | 'enum'
  values?: readonly string[]
  required?: boolean
}

export type Verb<World = unknown, Actor = unknown> = {
  name: string
  args: Record<string, ArgSchema>
  prompt: string                    // appears in LLM brain's verb manual
  handler: (actor: Actor, args: Record<string, unknown>, world: World)
    => Effect[]
}

export type Effect =
  | { kind: 'mutate', apply: (world: unknown) => void }
  | { kind: 'perceive', target: string | '*nearby*', event: PerceptionEvent }
```

Two effect variants; moodlet emission and action rejection become `perceive` events that the moodlet tracker / GM subscribe to. Matches the existing event-bus pattern in [pi-bridge/perception.js](../../agent-sandbox/pi-bridge/perception.js).

### GameAdapter — the per-game integration

```ts
export interface GameAdapter<World = unknown> {
  observe(characterId: string, world: World, tick: number): Observation
  schedule(world: World, tick: number): string[]
  verbs: ReadonlyArray<Verb<World>>
  identity: IdentityStore
}
```

Per-game policy lives here:

- `observe()` builds the Observation. ONI: tile state + nearby utilities. Sims: scene-mates + chat tail.
- `schedule()` returns characters that need a brain call this tick. ONI: ~30 per second. Sims: handful, perception-driven.
- `verbs` is the canonical action set; the harness validates shapes, the game validates semantics inside handlers.
- `identity` is the IdentityStore (below).

### PortableIdentity + IdentityStore (deferred surface area, sketched)

Used in Phase 0–2 as a name string lookup. Full schema lands when first cross-game character migration or first BYO-agent join happens.

```ts
export type PortableIdentity = {
  id: string                        // stable across games
  name: string
  about: string                     // character bible
  traits: string[]                  // promoted; append-only
  voiceHints?: string[]             // optional register hints
  createdAt: number
  updatedAt: number
}

export interface IdentityStore {
  load(id: string): Promise<PortableIdentity | null>
  save(identity: PortableIdentity): Promise<void>
  list(): Promise<PortableIdentity[]>
  // BYO-agent additions (deferred):
  // verify(challenge: SignedChallenge): Promise<{ id, trust }>
  // rateLimitState(id: string): RateLimitState
}
```

## 4. Reference implementations the harness ships

Located in `src/lib/harness/impls/`. None are mandatory.

- `brains/UtilityBrain` — score verbs by per-character considerations; pick top-K. Colony's default.
- `brains/DeterministicBrain` — emit a fixed verb based on trigger. Smoke tests.
- `brains/LLMBrain` (already exists in pi-bridge as PiHarness from [#135](../../tasks/135-agent-sandbox-harness-abstraction.md)) — adapter-of-adapters; pi / Agent SDK / on-device Gemma plug in as model drivers.
- `identity/MemoryIdentityStore` — in-memory; tests.
- `identity/LocalStorageIdentityStore` — browser/Capacitor.
- `identity/FileIdentityStore` — Node bridge.

Modules relocated from `agent-sandbox/pi-bridge/` (already runtime-neutral after small I/O abstraction):

- `perception.js` — typed ring buffer.
- `moodlets.js` — event-driven affect, mood bands.
- `needs.js` — decay axes + wellbeing.
- `memory.js` — verbatim past-scene injection (no summarization).

Pi-bridge re-imports from `src/lib/harness/` after Phase 0.

## 5. Repo layout

```
src/
├── lib/
│   ├── harness/                       [NEW]
│   │   ├── types.ts                   four interfaces above
│   │   ├── perception.js              relocated from pi-bridge
│   │   ├── moodlets.js                relocated from pi-bridge
│   │   ├── needs.js                   relocated from pi-bridge
│   │   ├── memory.js                  relocated from pi-bridge
│   │   ├── impls/
│   │   │   ├── brains/                UtilityBrain, DeterministicBrain
│   │   │   └── identity/              Memory, LocalStorage, File stores
│   │   ├── README.md
│   │   └── docs/
│   │       ├── HARNESS.md             interfaces, one page
│   │       └── integrating.md         adapter template + runnable walkthrough
│   │
│   ├── colony/                        [NEW] reference greenfield game
│   │   ├── adapter.js                 implements GameAdapter
│   │   ├── verbs.js                   mine, build, deliver, eat, sleep
│   │   ├── world.js                   tile grid, dupes, resources
│   │   ├── store.js                   localStorage save state
│   │   ├── utility.js                 scoring functions
│   │   ├── skill/                     [Phase 4] BYO-agent install bundle
│   │   │   ├── SKILL.md
│   │   │   ├── scripts/               bash → Colony HTTP API
│   │   │   └── references/
│   │   └── README.md
│   │
│   ├── shelterStore/, shelterWorld/   unchanged this plan
│   └── kimodo/                        unchanged
│
├── views/
│   ├── Colony.jsx                     [NEW] tile view + UI
│   ├── ColonyTile.jsx, ColonyDupe.jsx, ColonyDebug.jsx   [NEW]
│   └── Shelter*.jsx                   unchanged
│
agent-sandbox/pi-bridge/
└── (continues to import from src/lib/harness/ after Phase 0)

docs/
├── design/
│   └── agent-harness.md               (this doc)
└── research/
    └── agent-harness-2026.md          (research notes)

tasks/
├── 470-harness-extraction.md          Phase 0
├── 480-harness-interfaces.md          Phase 1
├── 490-colony-game-scaffold.md        Phase 2a
├── 500-colony-utility-ai.md           Phase 2b
├── 510-colony-sidebar-and-docs.md     Phase 3
└── 520-colony-skill-bundle.md         Phase 4 (optional)
```

`woid.config.json` gains `features.colony: true`.

## 6. Phasing

Five days of work, broken into four phases. Each has its own task card. **Sequence matters — Phase 0 unblocks everything else.**

### Phase 0 — Harness extraction ([#470](../../tasks/470-harness-extraction.md))

**Estimate: 1 day.**

Move `perception.js`, `moodlets.js`, `needs.js`, `memory.js` from `agent-sandbox/pi-bridge/` into `src/lib/harness/`. Make them runtime-neutral (browser + Node) by gating any I/O behind a passed-in dependency (already partial in moodlets.js).

Pi-bridge re-imports from the new location (shim re-exports during transition; deletion is a Phase 0 follow-up).

**Exit criteria:**
- `npm run agent-sandbox:smoke` passes.
- Shelter still works in the browser.
- The four modules are importable from both Node (pi-bridge) and the browser (future Colony view).

**Risk:** moodlets.js writes JSONL to a workspace. The fs interface must accept a browser-safe stub (or skip persistence in the browser).

### Phase 1 — Interfaces + UtilityBrain ([#480](../../tasks/480-harness-interfaces.md))

**Estimate: 0.5 day.**

Write `src/lib/harness/types.ts` with the four interfaces from §3. Add `src/lib/harness/impls/brains/UtilityBrain.js` — score advertised verbs by per-character considerations, pick top-K. Add `DeterministicBrain` for smoke tests. Add `MemoryIdentityStore` as the only IdentityStore needed for Phase 2.

No game uses the interfaces yet — these are the contracts Phase 2 will implement against.

**Exit criteria:**
- Types compile / JSDoc lints clean.
- `UtilityBrain.step()` returns a deterministic action given a stable input (smoke test fixture).
- `DeterministicBrain` returns `[{ verb: 'idle', args: {} }]` for any trigger.

### Phase 2 — Colony game ([#490](../../tasks/490-colony-game-scaffold.md), [#500](../../tasks/500-colony-utility-ai.md))

**Estimate: 2.5 days.**

#### 2a — Scaffold ([#490], 1 day)

- `src/lib/colony/world.js` — tile grid (24×16), 4 dupes, 3 resources (oxygen, food, power), 5 job types.
- `src/lib/colony/store.js` — `localStorage` under `woid.colony.v1`.
- `src/lib/colony/verbs.js` — `take_job`, `move_to`, `deliver`, `eat`, `sleep`. Each with args schema + handler + prompt string.
- `src/lib/colony/adapter.js` — `GameAdapter` implementation.
- `src/views/Colony.jsx` + `ColonyTile.jsx` + `ColonyDupe.jsx` — minimal view.

#### 2b — Utility AI + perception wiring ([#500], 1.5 days)

- `src/lib/colony/utility.js` — scoring functions. `score(verb, args, dupe, world) → number` based on need pressure, proximity, skill match.
- Wire `perception.js` into Colony's tick loop. Interest-managed: tile-change events only go to dupes within 3 tiles.
- Wire `moodlets.js` for stress (source: `environment` for breaker trips, etc.).
- `ColonyDebug.jsx` floating button — spawn/remove dupes, dump JSON, fast-forward.
- Colony tick budget: ≤2ms for 4 dupes.

**Exit criteria:**
- 4 dupes mine 100 ore autonomously without an LLM call.
- A stress event raises one dupe's stress > 80 → forced break verb.
- Persistence: refresh the page, state restores.
- No LLM cost incurred during Colony play.

### Phase 3 — Sidebar + docs ([#510](../../tasks/510-colony-sidebar-and-docs.md))

**Estimate: 1 day.**

- `woid.config.json` feature flag + sidebar route `#/colony`.
- `src/lib/harness/docs/HARNESS.md` — ≤2 pages, the four interfaces with one paragraph each.
- `src/lib/harness/docs/integrating.md` — ≤2 pages with a runnable template (copy `src/lib/colony/`, change names, register one new verb). Ends with "your game has agents now."
- Top-level README.md mentions the harness + the three demos (Sims via `#/agent-sandbox`, Shelter via `#/shelter`, Colony via `#/colony`).

**Exit criteria:**
- A clean clone runs `npm run dev`, clicks into Colony from the sidebar, sees dupes working.
- From `integrating.md`, someone unfamiliar with woid produces a "Hello World" adapter that emits a `wave` verb in under 30 minutes.

### Phase 4 — Colony skill bundle (optional, [#520](../../tasks/520-colony-skill-bundle.md))

**Estimate: 1 day.**

The BYO-agent install path. Just files, no protocol work.

- `src/lib/colony/skill/SKILL.md` — what Colony is, how to play, voice hints, verb manual.
- `src/lib/colony/skill/scripts/` — bash scripts that hit Colony's existing HTTP API.
- `src/lib/colony/skill/references/strategy.md` — appendix (loaded by Claude only when SKILL.md points to it).
- Auth: signed Nostr challenge via existing pi-bridge infrastructure.
- Brief recipe doc in `docs/byoa.md`: "Copy `colony/skill/` into your agent's skills directory, sign with a Nostr key, you're in."

**Exit criteria:**
- An OpenClaw / Hermes / Claude Code instance with the skill installed can adopt a Colony dupe and issue a `take_job` verb.

## 7. Deferred hooks (with triggers for activation)

These are explicit follow-ups. Each has a "when" condition; don't build until the condition fires.

| Hook | When | Effort | Notes |
|---|---|---|---|
| Lazy-materialized roster (Census pattern) | Colony scales past 8 dupes | 0.5 day | Spawn full state on profile / proximity, not pre-allocate. See [research §4](../research/agent-harness-2026.md#watch-dogs-legion--census-9m-procedural-npcs) |
| Long-term moodlet tier (DF middle layer) | Shelter multi-day arcs start hurting | 0.5 day | Third category in moodlets.js with retrieval-on-mention. See [research §4](../research/agent-harness-2026.md#dwarf-fortress--three-memory-tiers-the-missing-middle) |
| A2A Agent Card on NPCs | Phase 5b once BYO-agent join works | 0.5 day | Static JSON at `/.well-known/agent-card.json` per NPC; SSE stream existing |
| MCP server for verbs | When BYO-agent reach expands past shell-capable agents | 1–2 days | Wraps `gm.js` VERBS; uses `@modelcontextprotocol/sdk` |
| LLMBrain on a named Colony dupe | After Colony has ~10 sim-days of content | 1 day | Journal entry at session_close. Validates cross-brain seam |
| Shelter through GameAdapter | When Shelter wants LLM-driven characters | 1 day | Currently Shelter has its own deterministic schedule; doesn't need the harness yet |
| Pi-bridge consumes Brain interface | When a non-pi LLMBrain ships | 1 day | Refactor PiHarness → LLMBrain(pi). [#135](../../tasks/135-agent-sandbox-harness-abstraction.md) prep already done |
| Self-built skills (Hermes / Voyager) | Speculative; defer | n/a | Wrong abstraction for cozy life-sim |
| Voice guard classifier | If model drift is measured to occur | 0.5 day | Only worth it if we observe slipping into helpful-assistant register |

## 8. Risks

1. **Phase 0 breaks pi-bridge.** Mitigation: shim re-exports from the old pi-bridge paths during transition. Delete after Phase 0 lands and tests pass.
2. **Browser/Node module compatibility.** `moodlets.js` writes JSONL; needs an fs stub when imported in the browser. Already partially abstracted; verify the seam works.
3. **Utility AI dupes oscillate.** Mitigation: start with a 50-LOC scoring function. Add cooldown decorators only if oscillation happens.
4. **Scope creep into pi-bridge migration.** This plan keeps pi-bridge as-is. Resist refactoring it to consume the new interfaces during this work.
5. **Coupling between Colony view and Colony adapter.** Mitigation: views read from `store.js`; adapter reads from `world.js`. Same state, two readers, neither aware of the other.

## 9. Cross-references

### Existing tasks this plan touches

- [#135 — Harness abstraction (done)](../../tasks/135-agent-sandbox-harness-abstraction.md) — original PiHarness/DirectHarness/ExternalHarness interface inside pi-bridge. This plan generalizes the seam into a project-wide harness. **Status unchanged (done).**
- [#145 — DirectHarness (done)](../../tasks/145-agent-sandbox-direct-harness.md) — call-my-ghost-style direct SDK brain. Stays in pi-bridge; the harness library doesn't yet consume it.
- [#150 — ExternalHarness (done)](../../tasks/150-agent-sandbox-external-harness.md) — SSE turn-stream + authenticated act endpoint. The precursor to the BYO-agent direction in §7 / Phase 4.
- [#225 — World phase 1 grounded actions (done)](../../tasks/225-world-phase1-grounded-actions.md) — verb set + GM + scenes + journal. The substrate the four interfaces wrap.
- [#275 — Storyteller foundation (done)](../../tasks/275-storyteller-foundation.md) — moodlets + sim-day + recap. Relocating `moodlets.js` is the first dependency on this plan; behavior unchanged.
- [#305 — Card pool and Day 1 (done)](../../tasks/305-card-pool-and-day1.md) — director + action DSL. The card runtime is the LangGraph-shaped graph that this plan validates (research §5 / §6).
- [#140 — Global scheduler + unified perception (todo)](../../tasks/140-agent-sandbox-scheduler-and-perception.md) — built on top of #135. After Phase 0 it will be built on top of `src/lib/harness/` instead. No change required to #140; the import paths shift.
- [#175 — External driver status panel (todo)](../../tasks/175-agent-sandbox-external-driver-status.md) — debug UI for ExternalHarness clients. Useful precursor for BYO-agent observability.
- [#265 — World phase 5 LOD + SLM routing (todo)](../../tasks/265-world-phase5-lod-scale.md) — Cognitive Controller gating LLM calls. **The deferred "long-term moodlet tier" and "lazy-materialized roster" in §7 of this plan slot underneath #265's LOD work.** Coordinate when #265 starts.
- [#335 — Traits system (todo)](../../tasks/335-traits-system.md) — trait promotion + effects. **No change required for Phase 0–3.** The DF middle memory tier (deferred §7) interacts with promotion; flag for the #335 reviewer.

### Existing design docs referenced

- [shelter-agents.md](./shelter-agents.md) — Shelter's deterministic schedule (out of scope for this plan).
- [shelter-game.md](./shelter-game.md) — Shelter's progression spine (unrelated to Colony).
- [storyteller.md](./storyteller.md) — moodlets, three-clock card runtime. The relocation in Phase 0 must not break the card system this doc designs.
- [traits.md](./traits.md) — trait catalog. Unchanged.

### Research that justifies decisions

- [agent-harness-2026.md](../research/agent-harness-2026.md) — primary research note. All architectural decisions in this plan trace to a section in that doc.
- [llm-agents-2025-2026.md](../research/llm-agents-2025-2026.md) — broader LLM-agent survey (PIANO, AgentSociety, Concordia).
- [foundational-ai-patterns.md](../research/foundational-ai-patterns.md) — GOAP / BT / Utility / HTN. UtilityBrain follows the Utility AI pattern from this doc.
- [mood-systems.md](../research/mood-systems.md) — moodlet pattern across shipped games.

## 10. Open questions parked

These don't gate the next phase but should be resolved before BYO-agent ships:

1. **Memory ownership for joining player-agents.** Game-owned, agent-owned, or hybrid? [research §8.1](../research/agent-harness-2026.md#8-open-questions-parked-for-later)
2. **Offline behavior for player-agent characters.** Idle, fallback brain, or removed? Per-game policy.
3. **Cross-game identity portability.** Which fields of `PortableIdentity` travel between Sims/Shelter/Colony? Traits yes; moodlets and relationships likely no.

## 11. Lockable summary

| Layer | What ships in this plan | Where |
|---|---|---|
| Harness core | Four interface types, four relocated modules, UtilityBrain + DeterministicBrain + MemoryIdentityStore | `src/lib/harness/` |
| Reference game | Colony — 24×16 grid, 4 dupes, 5 verbs, utility AI, localStorage save, debug menu | `src/lib/colony/`, `src/views/Colony*.jsx` |
| Surface | Sidebar route `#/colony`, woid.config flag | `woid.config.json`, sidebar wiring |
| Docs | Two short docs (HARNESS.md, integrating.md) + research note | `src/lib/harness/docs/`, `docs/research/` |
| BYO-agent | Skill bundle (Phase 4, optional) | `src/lib/colony/skill/`, `docs/byoa.md` |

5 days for Phases 0–3, +1 day if Phase 4 ships in the same arc. Everything else is deferred until its trigger fires.

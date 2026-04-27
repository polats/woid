# Storyteller — session-bounded narrative loop

A concrete design for the engagement layer that turns woid from "ambient agents wandering" into "a daily generative soap opera." This proposal completes [#235](../../tasks/235-world-phase2-schedule-needs.md)'s deferred slice 4 (per-day event roll) and adds the session-recap layer that makes returning to the app *feel* like checking in on a story.

The design is built from four research-backed primitives — each is a named pattern from the [research notes](../research/index.md):

| Primitive | Source | Role |
|---|---|---|
| **Moodlets** | [mood-systems](../research/mood-systems.md), [RimWorld](../research/rimworld.md) | Replace the `curiosity` decay axis. Event-driven affect, summed into a 4-band wellbeing label. |
| **Three clocks** | [Barotrauma](../research/barotrauma.md) | Session arc / intensity director / per-card action list. Decoupled, inspectable, no central script. |
| **Card pool** | [Barotrauma](../research/barotrauma.md), [King of Dragon Pass](../research/king-of-dragon-pass.md) | Hand-authored beats, systemically selected. Cards as data, not code. |
| **Durable identity** | [Battle Brothers](../research/battle-brothers.md) | Long-running moodlets and arcs *promote* to traits on `about`. Death/departure is permanent and visible. |

The non-negotiable design rule is **decay for biology, events for psychology**. Energy and social decay over sim-time. Mood, relationships, traits, and arcs are *event-driven*.

---

## 1. Goals

1. **Drive return.** A user who opens the app should always find *something specific that happened today*, not generic ambient behavior.
2. **Compound investment.** Watching for ten sessions matters more than for one. Trait acquisition and named relationships make characters narratively load-bearing.
3. **No dead days.** Even a quiet roster fires *something* at sim-day rollover. Threshold drift guarantees movement.
4. **Inspectable end-to-end.** Every event in the recap is traceable to a card, a moodlet, and a perception event. No black-box prose.
5. **Additive content.** New cards, moodlet types, and traits ship as data files. No central script edits.

---

## 2. Architecture

```
                         ┌────────────────────────────────────────┐
                         │            Storyteller                 │
                         │                                        │
   sim-day rollover ───► │  Session clock (1 sim-day = 1 session) │
                         │                                        │
   intensity tick ─────► │  Director clock (scalar, asym lerp)    │
                         │                                        │
   card fires ─────────► │  Card runtime (action list)            │
                         └─────────┬──────────────────────────────┘
                                   │
                                   ▼ emits
                         ┌────────────────────────────────────────┐
                         │  Effects                               │
                         │  - moodlet add                         │
                         │  - perception event                    │
                         │  - state mutation (relationship, trait)│
                         │  - spawn / despawn                     │
                         │  - schedule next card                  │
                         └────────────────────────────────────────┘
```

**Three clocks** ([Barotrauma](../research/barotrauma.md#event-manager--the-ai-director)):

- **Session clock** — wall-clock cadence (default: 1 sim-day per real-time configurable interval). Fires `session_open` and `session_close` events. The `session_close` triggers recap generation.
- **Director clock** — runs continuously while the session is open. Maintains an `intensity` scalar in `[0, 1]`. Asymmetric lerp toward target: **rises in 25 sim-min, falls in 400 sim-min**. Asymmetry is the source of dramatic *valleys* — calm earned slowly is felt.
- **Card clock** — when a card fires, its action list executes step-by-step (with `WaitAction`, `Label`/`GoTo`, branching). Multiple cards can be in flight; they don't serialize.

The three clocks compose: the Session clock decides *that* something happens today; the Director clock decides *when* in the day; the card decides *how it plays out*.

---

## 3. Schemas

All schemas are JSON / JS objects. Files marked `*.json` are persisted; `*.js` are code.

### 3.1 Moodlet

```ts
type Moodlet = {
  id: string                // ulid; unique per emission
  tag: string               // "insulted_by:<pubkey>", "slept_well", "saw_friend:<pubkey>", "room_is_messy"
  weight: number            // signed integer, typical -10 .. +10
  source: "social" | "biology" | "environment" | "card" | "user"
  by?: string               // pubkey of the other character if relevant
  reason: string            // human prose for prompt + UI: "Bob called her stupid"
  added_at: number          // sim-time ms
  expires_at: number | null // null = sticky until removed
  severity?: 1 | 2 | 3      // tiered (PZ-style); optional
}
```

**Mood derivation** ([mood-systems](../research/mood-systems.md)):

```js
mood       = clamp(50 + Σ active.weight, 0, 100)
moodBand   = bandFor(mood)   // cheerful (≥70) | steady (≥40) | lousy (≥20) | breaking (<20)
```

**Prompt rendering**:
```
Mood: lousy. Recently:
  - Bob called her stupid (2h ago, fades in 22h)  [-8]
  - Slept poorly last night (12h ago, fades in 12h) [-3]
  - Room is messy (ongoing) [-2]
```

### 3.2 Card

Cards live as markdown files in `cards/` with frontmatter + body, mirroring our `tasks/` layout ([tasks-format](../tasks-format.md)).

```markdown
---
id: weaponthane-asks-shelter
weight: 10
once_per_session: false
exhaustible: false
intensity_min: 0.0
intensity_max: 0.5
trigger:
  any:
    - "world.has_outsider == false"
    - "world.season == 'winter'"
  none:
    - "world.has_card_active(/weaponthane-/)"
roles:
  host:
    select: random_character
    where: "char.has_trait('hospitable') or true"
  newcomer:
    spawn: stranger
    seed: name=Asborn, about="A travelling weaponthane, road-tired"
---

A traveler in mail and a worn cloak appears at the edge of the lights. They ask for guest-right.

actions:
  - SpawnAction:
      tag: newcomer
  - ConversationAction:
      speaker: newcomer
      target: host
      line: "Three nights of road and no fire. Will you take me in?"
  - LLMChoiceAction:
      character: host
      options:
        - id: welcome
          when: "host.has_trait('hospitable')"
          effect:
            - ModifyRel: { from: host, to: newcomer, delta: +5 }
            - EmitMoodlet: { on: host,     tag: "kept_guest_right",   weight: +3, expires: 1d }
            - EmitMoodlet: { on: newcomer, tag: "given_shelter",       weight: +6, expires: 2d }
            - SetData:     { key: "shelter_offered", value: true }
            - TriggerCard: { id: weaponthane-departs, after: 1d }
        - id: refuse
          effect:
            - ModifyRel: { from: host, to: newcomer, delta: -3 }
            - EmitMoodlet: { on: newcomer, tag: "refused_shelter", weight: -8, expires: 3d }
            - DespawnTag:  { tag: newcomer, after: 30m }
```

**Field semantics**:
- `trigger` — predicate over world state (`any` / `none` / `all`). Evaluated at director-tick time.
- `intensity_min/max` — only eligible when `currentIntensity` is in this window.
- `roles` — declarative tag-binding ([Barotrauma](../research/barotrauma.md#eventactions--the-scripting-dsl)). `select` picks an existing character; `spawn` creates one with a seed for the LLM.
- `actions` — ordered list interpreted by the [Action DSL](#34-action-dsl).
- `LLMChoiceAction` — when the action requires character judgment, the LLM chooses among options whose `when` predicate holds, given the character's `about` + moodlets + relationships. The model picks; the *effect* is deterministic.

### 3.3 Session

```ts
type Session = {
  id: string            // ulid
  sim_day: number       // monotonic
  opened_at: number     // sim-time ms
  closed_at: number | null
  intensity_history: { t: number, value: number }[]   // sampled
  cards_fired: { card_id: string, fired_at: number, role_bindings: Record<string, string> }[]
  perception_window: PerceptionEvent[]                // everything from opened_at..closed_at
  recap?: {
    body: string
    headline: string
    generated_at: number
  }
}
```

Persisted at `$WORKSPACE/sessions/{sim-day}.json`. Recaps are queryable by sim-day for the "Today / Yesterday / This week" UI surface.

### 3.4 Action DSL

Small, inspectable. Modeled after Barotrauma's EventActions. Implementation lives in `agent-sandbox/pi-bridge/storyteller/actions.js` as a verb registry mirroring `gm.js`'s VERBS pattern.

```
Effect verbs:
  SpawnAction         — create a character with a seed
  DespawnTag          — remove tagged character (departure / death)
  ConversationAction  — staged line, perception event
  LLMChoiceAction     — model picks among allowed options
  EmitMoodlet         — add moodlet to a character
  ClearMoodletByTag   — remove matching moodlets
  ModifyRel           — relationship delta in graph
  PromoteToTrait      — see §6
  SetData             — kv on session or world
  TriggerCard         — schedule another card (now or after delay)

Predicate verbs:
  CheckData
  CheckMood
  CheckRel
  CheckTrait
  RNG

Flow verbs:
  WaitAction
  Label / GoTo
  BinaryOptionAction
```

The DSL is extensible the same way `gm.js` verbs are: each entry declares `args`, `effects`, `prompt` (for system-prompt auto-generation), and `handler`.

---

## 4. Director — intensity scalar

[Barotrauma](../research/barotrauma.md#event-manager--the-ai-director) shape, adapted to a small-cast LLM sandbox.

```js
function computeTargetIntensity(world) {
  const lousyCount = chars.filter(c => c.moodBand === 'lousy' || c.moodBand === 'breaking').length
  const conflictCount = relationships.filter(r => r.affinity < -10).length
  const lowNeedsCount = chars.filter(c => c.needs.energy < 30 || c.needs.social < 30).length
  const charsTotal = Math.max(1, chars.length)

  const moodPressure   = lousyCount    / charsTotal           // 0..1
  const socialPressure = conflictCount / (charsTotal + 1)     // 0..1
  const needPressure   = lowNeedsCount / charsTotal           // 0..1
  const eventPressure  = clamp01(scaleByRecency(recentEvents, 6 * SIM_HOUR))

  // Dampen pressure if the day has been eventful (cards fired) so we don't pile on.
  const recentCards = cardsFiredInWindow(2 * SIM_HOUR).length

  return clamp01(
    0.4 * moodPressure +
    0.3 * socialPressure +
    0.2 * needPressure +
    0.1 * eventPressure -
    0.15 * recentCards
  )
}

// Asymmetric lerp — Barotrauma's 25s up / 400s down, scaled to sim-time.
const RISE_SIM_MIN = 25
const FALL_SIM_MIN = 400
function tickIntensity(state, simMinElapsed) {
  const target = computeTargetIntensity(state.world)
  const tau = target > state.intensity ? RISE_SIM_MIN : FALL_SIM_MIN
  state.intensity += (target - state.intensity) * (simMinElapsed / tau)
}
```

**Threshold drift to prevent dead days** ([Barotrauma](../research/barotrauma.md#event-manager--the-ai-director)):

```js
// If no card has fired in the first half of the day, lower the bar.
const hoursSinceLastCard = (now - state.lastCardAt) / SIM_HOUR
const driftedThreshold = baseThreshold - 0.05 * Math.max(0, hoursSinceLastCard - 6)
```

A card fires when `intensity >= card.intensity_min` and `intensity <= card.intensity_max` and `intensity >= driftedThreshold` and the card's `trigger` predicate holds and global `cooldown` is zero.

Selection from the eligible set: weighted random by `weight` * (1 / (1 + recencyPenalty)).

---

## 5. Lifecycle

### 5.1 Session open

Wall-clock event (e.g. 8 AM sim-time, configurable cadence) fires `session_open`:

1. Allocate a `Session` record, increment `sim_day`.
2. Roll **opening cards** — eligible cards with `phase: opening` (e.g. weather, arrivals). Up to N (default 1).
3. Reset per-session counters (`once_per_session` flags, exhaustibles' eligibility).
4. Promote yesterday's lingering moodlets if applicable (see §6).
5. Resume director clock.

### 5.2 During the session

- Director ticks every 5 sim-min, recomputes intensity.
- When a card becomes eligible AND its action list slot is free, it fires.
- Card actions execute against the world; moodlets land; perception events flow.
- Characters take turns as before (existing harness loop), but their prompts now include the moodlet block, the active relationship summary, and any *staged lines* from in-flight `ConversationAction`s.

### 5.3 Session close

Wall-clock event (e.g. 11 PM sim-time) fires `session_close`:

1. Snapshot `perception_window`.
2. Roll **closing cards** with `phase: closing` (departures, sleep, late-night encounters).
3. Generate **recap** — single LLM call to a small model (Sonnet/Haiku tier) with:
    - Today's perception window (filtered to "noteworthy": cards fired, moodlets emitted with `|weight| ≥ 5`, relationship deltas with `|delta| ≥ 3`, deaths/departures).
    - Character roster with current `about` + moodlets + traits.
    - System prompt: "Write a 100–150 word recap in past tense, named characters, present-tense headline ≤8 words. No invented facts — every named event must come from the perception window."
4. Persist recap into the session record.
5. Run **moodlet expiry + trait promotion** (see §6).
6. Pause director clock; emit `session_close` event.

### 5.4 Recap rendering

The UI's home surface becomes a stack of recent recaps:

```
Today, sim-day 47 — "Asborn arrives in winter cold"
  Two travelers entered the village before dawn. Alice gave shelter; Bob refused
  and they argued. By dusk Alice had spent twice as much time with the stranger
  as with Bob; Bob slept poorly. Cleo finished the loom she started yesterday.

Yesterday, sim-day 46 — "Cleo's loom"
  ...
```

Tapping a recap opens the source view: the ordered list of perception events + cards fired, each clickable.

---

## 6. Trait promotion — turning mood into identity

[Battle Brothers](../research/battle-brothers.md) acquires traits in play; [DF](../research/mood-systems.md#dwarf-fortress--thoughts-and-stress) adjusts personality from sustained thought patterns. We do the same in miniature.

**Rule**: a moodlet pattern that's been emitted ≥ N times in the last M sim-days, OR a sticky moodlet that has lived ≥ K sim-days, *promotes* to a durable entry on `about`.

```js
const PROMOTION_RULES = [
  { match: "insulted_by:*", count: 5, window: 30 * SIM_DAY,
    trait: c => `Resentful of ${c.from}` },
  { match: "saw_friend:*",  count: 20, window: 30 * SIM_DAY,
    trait: c => `Close to ${c.from}` },
  { match: "slept_poorly",  count: 10, window: 14 * SIM_DAY,
    trait: () => "Insomniac" },
  { match: "given_shelter", sticky_days: 7,
    trait: () => "Grateful (was given shelter when stranded)" },
]
```

Promotion produces a one-line entry appended to the character's `about` (visible to the LLM and the user) and emits a perception event so other characters can witness the change. The triggering moodlets are *cleared* on promotion.

This is the single bridge between short-term mood (this week) and long-term identity (this character). Without it, moodlets are weather; with it, they accumulate into character.

---

## 7. Permadeath / departure

Characters can leave the world via:

1. **Card-driven departure** — `DespawnTag` action with `reason: "left for the coast"` or `reason: "died of fever"`.
2. **Player-driven** — user removes a character from the UI.
3. **Self-driven** (late-slice) — the LLM emits a `leave` verb during high-distress mood states.

When a character departs:
- Their record is moved to `$WORKSPACE/memorial/<pubkey>.json` with a tombstone snapshot.
- All moodlets on others *that reference them* (`by: <pubkey>`) are converted to memorial moodlets (`tag: "misses:<pubkey>"`, weight halved, expiry doubled, sticky).
- A `departure` perception event is emitted.
- The next recap leads with the departure.
- Their bedroom / claimed objects become unowned.

Departure is *narratively expensive*. It produces a session that's almost guaranteed to feel meaningful.

---

## 8. Storage

```
$WORKSPACE/
├── characters/                  # existing
├── objects.jsonl                # existing
├── moodlets/<pubkey>.jsonl      # NEW — append-only, expired entries pruned at session close
├── sessions/<sim-day>.json      # NEW — per-session record incl. recap
├── relationships.jsonl          # NEW — append-only delta log; folded into a Map at boot
├── world.json                   # NEW — world-level state (sim-day, season, flags)
└── memorial/<pubkey>.json       # NEW — tombstones for departed characters

cards/                           # NEW — repo-tracked content
├── opening/<id>.md
├── ambient/<id>.md
└── closing/<id>.md
```

Cards are version-controlled in the repo (designer content). Sessions and moodlets are workspace-local (per-deployment).

---

## 9. UI surfaces

| Surface | Change |
|---|---|
| **Vitals panel (AgentProfile)** | 2 need bars (energy, social) + moodlet list with relative timestamps + traits subsection |
| **Map** | Wellbeing dot driven by moodBand (already in place). Add card-fired indicator (small flag over a tile when a card is firing there). |
| **Home / Sandbox** | Today's recap card pinned at top. Stack of past recaps below. Director's intensity sparkline as a thin line under the recap. |
| **Inspector** | "Today" tab — chronological list of cards fired + moodlets emitted, each clickable to source perception. |
| **Memorial** | New page — list of departed characters with their final recap line. |

---

## 10. Slices

The work is large. Order matters because each slice ships a visible feature and validates the next.

**Slice 1 — Moodlets foundation** (replaces `curiosity` axis)
- `agent-sandbox/pi-bridge/moodlets.js` — emit / list / expire / sum / band
- Replace third decay axis in `needs.js`; mood is now a separate, parallel system
- Integrate moodlet block into prompts via `buildContext.js`
- Vitals UI: 2 need bars + moodlet list

**Slice 2 — Sim-day boundary + recap**
- Session record at `$WORKSPACE/sessions/`
- Sim-day rollover wires (cron or interval)
- Recap LLM call with strict "no invented facts" prompt
- Home UI: pinned recap

**Slice 3 — Storyteller card pool v0**
- Card loader from `cards/*.md`
- Trigger predicate evaluator
- Action DSL runtime (verbs: Spawn, Despawn, Converse, EmitMoodlet, ModifyRel, SetData, TriggerCard, LLMChoice, Wait)
- Author 10–15 cards: arrival, weather, argument, festival, item-found, late-night-encounter, illness, gift, departure, dream, gossip
- Director with intensity scalar + threshold drift

**Slice 4 — Trait promotion**
- Promotion rules engine running at session-close
- About-field append + perception event on promotion
- Memorial flow for departures

**Slice 5 — Multi-day arcs**
- Card chains via `TriggerCard` + `SetData`
- Author 3–5 multi-card arcs (the weaponthane returns, the feud escalates, the festival approaches)

**Slice 6 — Player intervention**
- User can manually fire a card (debug surface initially)
- User can edit a moodlet
- User can write a card from the UI (LLM proposes, user curates)

Slices 1–3 are the engagement-loop MVP. Slices 4–6 deepen.

---

## 11. What this proposal explicitly rejects

- **A numeric mood bar.** The bar is debt the LLM can't reason about. Show the moodlet list ([mood-systems](../research/mood-systems.md#lessons-for-an-llm-sandbox)).
- **Resetting the world on character death.** The persistence is the hook. Memorial > rerun.
- **Procedural prose.** Every card is human-written. The LLM provides character voice on top of authored beats. KoDP's choice ([king-of-dragon-pass](../research/king-of-dragon-pass.md)).
- **A 24-slot schedule per character.** Schedules can come later (#235 slice 3) but this proposal does not depend on them. Sim-day rhythm is enough scaffolding.
- **A free-form "anything goes" LLM storyteller.** The Storyteller is constrained to the action DSL. LLM proposes new cards offline; the human reviews them into the repo. This is the [Skyrim Radiant AI veto layer](../research/elder-scrolls-radiant-ai.md) lesson.
- **A traits stat block.** Traits live as one-line entries in `about`. The LLM is the type system.

---

## 12. Open questions

1. **Real-time cadence.** Default sim-day length in real-time? Candidates: 30 min (active), 6 hr (slow), or user-configurable per workspace. I'd ship configurable default 30 min and a "sleep mode" toggle.
2. **Recap model tier.** Sonnet vs Haiku for recap generation? Recap is short and quality-sensitive — start with Sonnet, evaluate downgrade.
3. **Card author-time vs runtime LLM.** Should the LLM be able to *author cards* (with human review), or only *play* them? My take: author-with-review only after slice 3 ships and we have a content baseline.
4. **Multi-character LLM choices.** When `LLMChoiceAction` involves two characters' simultaneous decisions, do we run them in parallel and resolve conflicts, or staged? Stage by initiative, simpler.
5. **Card visibility to characters.** Does a character "know" they're in a card? My take: no. Cards manipulate world state and emit perception events; characters react to perceptions normally.
6. **Where does the storyteller run?** New module `agent-sandbox/pi-bridge/storyteller/` or its own service? Start as a module in pi-bridge; extract if it grows.

---

## 13. Where this slots into the task plan

This proposal completes the open work in [#235](../../tasks/235-world-phase2-schedule-needs.md) (slice 4 = card pool / event roll, plus the recap layer that wasn't originally scoped) and front-loads pieces of [#255](../../tasks/255-world-phase4-relationships-memory.md) (the relationship graph is necessary substrate for moodlet `by:` aggregation).

Suggested task-board changes:

- Update #235 description to reference this design doc as the authoritative spec for slice 4.
- New task **#275 — Storyteller and session-loop** with slices 1–6 above as sub-bullets.
- #255 (relationships) shrinks to "graph queries over moodlets + promoted traits" since the storage primitive is owned by this design.

---

## 14. Summary

Three clocks (session / director / card) over a moodlet substrate, with hand-written cards picked by a small ranker, recaps at session close, and a promotion path from short-term moodlets to durable identity. Each component is a primitive borrowed from a shipped game we have research notes on; nothing is novel except the LLM filling character voice inside an inspectable scaffold.

The minimum-viable version is slices 1–3: moodlets, sim-day recap, and ten cards. That's enough to validate whether daily recaps pull users back. Everything else is depth.

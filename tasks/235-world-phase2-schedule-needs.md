---
name: World phase 2 — schedules, needs, and per-day event roll
description: Cheap deterministic behavior layer. Personality enum picks an activity timetable; needs vector ticks server-side; LLM is consulted only when a need crosses threshold or the timetable advances. Flips the cost model from per-tick to per-event.
status: blocked
order: 235
epic: world
superseded_by: [275, 295, 305, 315, 325]
---

> **Status note (2026-04):** This card is **superseded** by the storyteller / vertical-slice design captured in [docs/design/storyteller.md](../docs/design/storyteller.md), [docs/design/vertical-slice.md](../docs/design/vertical-slice.md), and [docs/design/threads-arcs-loops.md](../docs/design/threads-arcs-loops.md). Pieces have moved as follows:
>
> - Needs vector → narrowed to `{energy, social}`; curiosity replaced by the **moodlet** system (#275).
> - Personality enum + activity timetables → **dropped**. Identity lives in `about`; behavior is shaped by moodlets, threads, traits.
> - Daily event roll → reshaped as the **card pool + director** (#305).
> - Mood enum → derived **mood band** from moodlet sum (#275).
> - LLM gate → still a cost lever; now lives inside #305's director.
>
> Slice 1 of the original design (3-axis needs + sim-clock decay + low-threshold interrupts) shipped; that's the substrate #275 builds on.
>
> Body below preserved for historical reference. **Don't work this card directly** — pick up #275 / #295 / #305 / #315 / #325 instead.

---

Depends on #225 (verb set + GM). This card is the single biggest cost lever in the world plan: it makes 90%+ of NPC behavior happen *without* an LLM call, while keeping the world feeling alive.

The research case (see `docs/research/animal-crossing.md`, `docs/research/the-sims.md`, `docs/research/tomodachi-life.md`, `docs/research/llm-agents-2025-2026.md` §2):

- Animal Crossing villagers run on a 24-slot personality-keyed timetable rolled once per in-game day. Cheap, persistent-feeling, scales to hundreds of idle NPCs.
- The Sims runs entirely on a needs vector ticking deterministically; the only "AI" is utility-scored selection over advertised affordances.
- Tomodachi Life adds a per-day event roll on top of the timetable for emergent narrative without an authored arc.
- HiAgent (ACL 2025) shows subgoal-as-memory-chunk is the right shape for keeping schedule context cheap.

## Deliverables

### Personality enum

- 8–12 named types (Tomodachi-style). Picked at character creation, immutable. Stored on the character manifest.
- Each type maps to: a default activity timetable, mood biases, event-roll weights, and dialogue tags.
- `agent-sandbox/shared/personalities.js` is the single source of truth.

### Needs vector

- Server-side, ticking once per simulated minute (configurable). Five axes to start: hunger, energy, social, fun, hygiene.
- Decay rates conditioned on personality + current activity.
- A need crossing a threshold raises an *interrupt* — the timetable yields, the LLM is consulted to pick a verb plan to address the need.
- Need state persists per-character (extends the SQLite store from #215 with a `needs` JSON column).

### Activity timetable

- Daily timetable rolled at midnight using a per-NPC seed: `(personality, day-of-year, character-pubkey)`. Pinned for the day.
- Each slot resolves to a verb-plan template (move to location → use object → idle for N minutes), executed by the GM.
- Templates declare which need they satisfy; satisfying a need ends the slot early.
- Personalities have ~10 timetable templates each; the daily roll picks one weighted by mood.

### Daily event roll

- At midnight rollover, draw 0–2 events per NPC from a table conditioned on `(personality, mood, relationships, world state)`. (Tomodachi pattern.)
- Most days roll mundane (`hungry-for-something-specific`, `wants-to-talk-to-X`); occasionally narrative (`makes-a-confession`, `picks-a-fight`).
- Events become injected into the timetable as override slots.

### Mood enum

- 5 visible states (happy / content / neutral / sad / angry). Computed deterministically from the needs vector + recent events.
- Rendered as a small badge above the NPC sprite in the client.
- Available to the LLM as a single token in perception.

### LLM gate

- The "should we call the LLM this tick?" decision is centralized: ask only when (a) a verb plan ends, (b) a need interrupt fires, (c) a social trigger fires (someone said something to me), (d) a daily event injects.
- Idle ticks resolve at the rules layer with `noop` or `wait`. Track gate hit rate in the cost dashboard from #185.

## Acceptance

- A village of 20 NPCs runs for a simulated day with <5% of ticks calling the LLM.
- NPCs visibly follow timetables (the bakery NPC is at the bakery in the morning; the night-owl NPC is awake at 02:00).
- A need crossing threshold visibly causes an NPC to deviate from their timetable (gets up from a chair to go eat).
- Mood badges shift over the day in observable ways tied to needs and events.
- A daily event observably fires for at least one NPC without scripted intervention.
- Token cost per simulated NPC-hour drops to a measurable fraction of phase 1 baseline.

## Non-goals

- Smart Objects advertising affordances (#245).
- Relationship state (#255) — events that mention "X" still resolve to the same target NPC for now.
- Per-personality dialogue table authoring beyond a small starter set; the LLM still writes most lines.
- Cross-day need interactions (e.g. a streak of poor sleep changing personality) — keep needs day-bounded for now.

## Risk notes

- The seed/pin discipline matters: if timetables re-roll on every interaction, the world stops feeling consistent. Pin once at midnight and treat as immutable for the day.
- Need decay tuning is the kind of thing that takes weeks to feel right. Ship with conservative rates and a debug overlay to inspect them.
- Don't let the timetable system grow a DSL until we have 3+ personalities authored against it. Start with imperative templates.

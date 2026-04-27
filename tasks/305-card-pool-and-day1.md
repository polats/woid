---
name: World — Card pool, director, and authored Day 1
description: The hand-authored content pipeline. Card schema in `cards/*.md`, director with intensity scalar, action DSL, and the authored Day-1 hook (cold open, seed residents, cliffhanger).
status: todo
order: 305
epic: world
depends_on: [275, 285, 295]
---

The content engine described in [docs/design/storyteller.md §3.2 and §4](../docs/design/storyteller.md#32-card) plus the audience-tuned Day-1 reshape from the brainstorm captured in [docs/design/vertical-slice.md](../docs/design/vertical-slice.md) (replacement for §5 forthcoming).

This is where the project goes from "moodlets exist and a recap fires" to "characters have things happen to them." It depends on #275 (sim-day, recap), #285 (rooms — cards target rooms), and #295 (threads — cards plant/advance them).

## Slices

### Slice 1 — Card loader + schema

- `agent-sandbox/pi-bridge/storyteller/cards.js` — load all `cards/**/*.md` at boot, parse frontmatter, validate against schema, hot-reload in dev.
- Card schema per [docs/design/storyteller.md §3.2](../docs/design/storyteller.md#32-card), extended with the [#295](295-narrative-state.md) thread/arc bindings.
- Card phases: `cold_open` (pre-onboarding), `opening` (session_open), `ambient` (mid-session), `cliffhanger` (just before close), `closing` (session_close).

### Slice 2 — Action DSL runtime

- `agent-sandbox/pi-bridge/storyteller/actions.js` — verb registry mirroring `gm.js`'s VERBS pattern.
- Verbs per [docs/design/storyteller.md §3.4](../docs/design/storyteller.md#34-action-dsl): `SpawnAction`, `DespawnTag`, `ConversationAction`, `LLMChoiceAction`, `EmitMoodlet`, `ClearMoodletByTag`, `ModifyRel`, `SetData`, `CheckData`, `TriggerCard`, `WaitAction`, `Label`, `GoTo`, `RNG`.
- `ScriptedEvent`-style runner with `Label`/`GoTo` validated at load time.
- Card runs as a step machine; multiple cards can be in flight in parallel.

### Slice 3 — Director + intensity scalar

- `agent-sandbox/pi-bridge/storyteller/director.js`.
- Intensity computation per [docs/design/storyteller.md §4](../docs/design/storyteller.md#4-director--intensity-scalar): worth-axis warmth-biased rather than danger-biased — see [vertical-slice.md §3](../docs/design/vertical-slice.md#3-tonal-calibration).
- Asymmetric lerp (Barotrauma pattern): rises in 25 sim-min, falls in 400 sim-min.
- Threshold drift: if no card has fired in the first half of the day, lower the bar so something fires.
- Card selection: weighted random over eligible cards filtered by trigger predicate, intensity window, room, `once_per_session`/`exhaustible` flags.
- `is_first_session: true` flag raises the intensity ceiling so Day 1 fires more dense content (the [audience-stickiness brainstorm](../docs/design/vertical-slice.md) target was 8–10 cards on Day 1).

### Slice 4 — Authored Day 1 + seed residents

- `cards/seed_residents/<id>.md` schema for hand-authored characters that arrive without player intervention. Each seed has full `about`, default position (room id + tile), `seed_role` (`founder` / `mysterious` / `catalyst`).
- Default seed pair: **Mara** (founder, 1A, has history) and **Tomek** (catalyst, arrives mid-Day-1).
- 10–12 hand-written Day-1 cards covering: cold open (the half-finished tea), arrival (player char), founder introduction, surprise third resident, the tea-choice player request, evening density beats, cliffhanger (the package on the doormat).
- Seeded threads: `previous-tenant-mystery`, `mara-tomek-history`, `the-phone-call-voice`.
- Seeded multi-day arc: `tea-inheritance` (3 cards across 3 sim-days, depending on Day-1 player choice).

### Slice 5 — Player Approve/Decline UI

- `src/RequestQueue.jsx` — surfaces `LLMChoiceAction` items that include a `player_choice: true` flag.
- Approve / Decline / ignore options. Decisions route back into card runtime via `SetData`.

### Slice 6 — Tonal calibration tests

- Automated checks at the recap layer: detect em-dashes, "I'm sorry", list-formatting tells; flag for review.
- Distribution check: in any 7-day window, ≥ 60% of fired cards are intensity ≤ 0.4 (the warmth tier).
- Manual rubric for Day-7 recap (named callbacks to Day-1 events).

## Acceptance

- A fresh workspace plays the Day-1 authored sequence end-to-end without the user creating a second character: cold-open tableau → onboarding → founder introduction → third resident arrival → tea choice → evening cards → cliffhanger.
- The session_close recap mentions ≥ 2 named characters and ≥ 1 of the seeded threads.
- The player-choice tea moment branches reliably to one of three downstream Day-2 states.
- The Stories panel shows ≥ 3 open threads at end of Day 1.
- Day 4–7 cards reference threads planted on Day 1 (verifiable by inspecting card frontmatter `advances_thread:` declarations).
- The director's intensity scalar correctly throttles card firing — running with no player input, the day produces 8–10 cards, not 50.

## Non-goals

- LLM authoring of cards (cards are human-written, LLM proposes for review only — defer to v2).
- Persistent multi-week arcs (>3 sim-days). Slice 4 ships only 3-step arcs.
- Festival / holiday cards — date-keyed content is a Day-14+ feature.
- Cards that mutate the building layout (room construction) — that's #285's territory.

## Risk notes

- The biggest risk is **slop voice** in any of the 12 authored Day-1 cards. Each card's prose should be hand-written by a human (or LLM-drafted then human-edited). One bad recap line on Day 1 and the audience is gone.
- Director tuning will take iteration. Ship with verbose intensity logging in the inspector so we can see why a card did or didn't fire.
- Card hot-reload in dev is essential — restarting the bridge for every card edit is a productivity killer.

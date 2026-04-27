---
name: World — Storyteller foundation (moodlets, sim-day, recap)
description: Foundational substrate for the session-bounded narrative loop. Adds the moodlet system (replacing curiosity decay axis), the sim-day boundary with a recap LLM call, and the home-screen recap stack.
status: done
order: 275
epic: world
supersedes: 235
---

The first vertical of the storyteller engine described in [docs/design/storyteller.md](../docs/design/storyteller.md), tuned for the audience defined in [docs/design/vertical-slice.md](../docs/design/vertical-slice.md). This is the substrate that everything else (cards, threads, traits, shop) sits on. Ship this and we have a daily-recap loop with no hand-authored content yet.

## Slices

### Slice 1 — Moodlets

- New `agent-sandbox/pi-bridge/moodlets.js` mirroring `needs.js`/`objects-registry.js`.
- Moodlet record per [docs/design/storyteller.md §3.1](../docs/design/storyteller.md#31-moodlet) (`tag`, `weight`, `source`, `by?`, `reason`, `added_at`, `expires_at`, `severity?`).
- API: `emit(pubkey, moodlet)`, `clearByTag(pubkey, pattern)`, `listActive(pubkey)`, `expireDue(now)`, `aggregate(pubkey)` → `{ mood, band, breakdown }`.
- Persistence: `$WORKSPACE/moodlets/<pubkey>.jsonl`. Append-only; expired entries pruned at session_close.
- Replace third decay axis (`curiosity`) in `needs.js`. `needs` keeps `energy` and `social` only.
- Update `buildContext.js` so the user-turn prompt includes a `Mood: <band>. Recently: …` block.
- Update `AgentProfile.jsx` Vitals: 2 need bars + a moodlet list with relative timestamps. Drop the curiosity slider.
- Update `RoomMap.jsx` wellbeing dot to drive off mood band, not needs.

### Slice 2 — Sim-day boundary + recap

- Add a sim-clock to the bridge with configurable cadence (default: 1 sim-day = 1 real-day, rollover at user-local 5 AM; alternate dev cadence: 1 sim-day = 30 real-min).
- `agent-sandbox/pi-bridge/storyteller/session.js` (new module) — opens/closes session records.
- Session schema per [docs/design/storyteller.md §3.3](../docs/design/storyteller.md#33-session). Persisted at `$WORKSPACE/sessions/<sim-day>.json`.
- At session_close: collect noteworthy perception events (cards-fired markers added in #305; for now: moodlets with `|weight| ≥ 5`, relationship deltas, departures), call a "recap" LLM with strict prompt enforcing past tense, named characters, no list formatting, no em-dashes, no slop tells.
- Endpoints: `GET /sessions`, `GET /sessions/:id`, `GET /health/sessions`.
- New `src/Recap.jsx` — pinned recap card on the Sandbox home view; stack of past recaps below.

## Acceptance

- A workspace running for two sim-days produces two persisted Session records each with a recap.
- The recap reads as past-tense, named-characters narrative — manually graded against the [vertical-slice.md §3](../docs/design/vertical-slice.md#3-tonal-calibration) recap-voice rubric.
- The home screen shows yesterday's recap pinned; clicking opens the session detail with the source perception events.
- A character with a `-8 weight` insulted-by moodlet has it visible in the AgentProfile Vitals tab; expiry visibly fades it after the configured duration.
- The third decay axis is gone; needs vector is `{energy, social}` everywhere.

## Non-goals

- The card pool, director, or intensity scalar — those land in #305.
- Threads/arcs/loops as separate state — those land in #295.
- Trait promotion — #315.
- Recap quality is "passable", not "Pulitzer." Voice iteration is a follow-up.

## Risk notes

- The recap prompt is the load-bearing piece for audience trust. One slop recap on Day 1 and the user is gone. Hand-author 5 example recaps to use as few-shot in the system prompt; iterate on the prompt before opening the slice for review.
- Sim-clock cadence in dev needs an "advance now" debug button so we can test rollover without waiting.
- Moodlets storage is JSONL; we need a compaction step at session_close so it doesn't grow unbounded for long-lived workspaces.

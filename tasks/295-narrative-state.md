---
name: World — Narrative state (threads, arcs, loops, ambitions, quests) + Stories UI
description: First-class narrative state in five flavors — threads (open dramatic questions), arcs (multi-card scripted sequences), loops (recurring patterns), ambitions (long-term character goals), quests (mid-term self-set objectives). Browsable in the Sandbox UI alongside scenes.
status: todo
order: 295
epic: world
---

Specified in [docs/design/threads-arcs-loops.md](../docs/design/threads-arcs-loops.md) (world→character) and [docs/design/quests-ambitions.md](../docs/design/quests-ambitions.md) (character→world). The taxonomy distinction across the five objects is load-bearing — collapsing into a single "story" object is what most LLM-agent demos get wrong.

The user-facing pitch: *"every recap card I read references a thread; every thread has a timeline I can browse; every character has loops, ambitions, and quests I can see."*

## Slices

### Slice 1 — Schemas + storage

- New `agent-sandbox/pi-bridge/narrative.js` (or split into `threads.js` / `arcs.js` / `loops.js` if it grows).
- Schemas per [docs/design/threads-arcs-loops.md §2](../docs/design/threads-arcs-loops.md#2-schemas).
- Persistence: `$WORKSPACE/narrative/{threads,arcs,loops}.jsonl` append-only.
- API: CRUD per object class; `appendEvent(thread_id, event)`; `bumpLoop(loop_id, observation)`.

### Slice 2 — Card frontmatter bindings

- Card schema (introduced in #305) gains `plants_thread:`, `advances_thread:`, `resolves_thread:`, `part_of_arc:` keys.
- Card runtime updates thread/arc state on fire.
- Arc step-runner: when an arc is in `in_progress`, the director schedules its next step at `delay_after`.

### Slice 3 — HTTP endpoints

- `GET /threads`, `GET /threads/:id`, `POST /threads`, `PATCH /threads/:id`
- `GET /arcs`, `GET /arcs/:id`, `POST /arcs`, `PATCH /arcs/:id`
- `GET /loops`, `GET /loops/:id`, `POST /loops/:id/promote`
- `GET /health/narrative` — count summary for UI badges.

### Slice 4 — Stories panel UI

- New `src/Stories.jsx` — Stories tab in the inspector with three sub-tabs (Threads / Arcs / Loops).
- List views per [docs/design/threads-arcs-loops.md §4](../docs/design/threads-arcs-loops.md#4-ui-surfaces).
- Detail view with chronological event log, related characters/objects as chips.
- Recap cards show inline thread chips when a recap relates to an active thread.

### Slice 5 — LLM prompt block injection

- `buildContext.js` adds an "Active threads / Your loops / Currently in arc" block per character turn, scoped to threads where the character is a participant or has perception events.

### Slice 6 — Loop detector

- Runs at session_close. Pattern-matches the perception window for recurring (cadence, participants, location) clusters.
- Updates loop observations / status. Surfaces `promotion_score` candidates.

### Slice 7 — Ambitions and quests

- Schemas per [docs/design/quests-ambitions.md §2](../docs/design/quests-ambitions.md#2-schemas).
- Storage: `$WORKSPACE/narrative/{ambitions,quests}.jsonl` (alongside the threads/arcs/loops stores).
- New verbs in `gm.js`: `set_quest`, `complete_quest` (plus optional `declare_ambition`). Hard caps: 1 quest declaration per turn; 3 active quests per character.
- Character-creation flow gains an LLM-proposed-ambition step (review-and-edit before commit).
- HTTP: `GET/POST/PATCH /ambitions`, `GET/POST/PATCH /quests`.
- Stories panel gains "Ambitions" and "Quests" sub-tabs per [docs/design/quests-ambitions.md §5](../docs/design/quests-ambitions.md#5-ui-surface).
- Prompt block: each character's turn includes `Your ambition: ...` and `Your current quests: ...` (only that character's own).
- Recap pipeline learns to prefer ambition milestones / quest completions for headline picking.

## Acceptance

- Firing a card with `plants_thread:` creates a Thread record; the Stories panel shows it.
- An arc with 3 steps over 3 sim-days fires correctly; the Arc record reflects step state and delay timing.
- After Marisol uses the kettle in the morning 5 sim-days in a row, a Loop with status `nascent` (or `established` if observations ≥ 7) appears in the Loops tab.
- The character turn prompt includes the character's active threads (only ones they participate in) and active loops.
- Resolving a thread emits a `thread_resolved` perception event; the next session's recap leads with it.
- The Stories panel badge counts (open threads, active arcs, established loops) update without page reload.

## Non-goals

- User-authored threads ("I want the system to deliver this story") — defer to v2; risks "the player wrote a query the system can't satisfy."
- LLM-detected thread planting beyond a conservative threshold — start with storyteller-authored only.
- Cross-character loop sharing (loops between A & B visible to C) — privacy default is loop-participants only.

## Risk notes

- Thread spam: aggressive LLM-detection floods the panel. Default the detector OFF for slice 1; turn it on under a config flag once we have manual content baseline.
- Schema churn: thread/arc fields will iterate fast. Keep storage append-only JSONL with a `schema_version` field on each row so we can fold-with-migration on read.
- Loop detection is genuinely hard. Ship the simplest cadence-matcher; revisit with embeddings later.

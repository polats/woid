---
name: World — Recap quality + sparse-day handling
description: Lower the rate at which the recap LLM degenerates to fallback. Surface ambient signals (need_low crossings, moodlet expirations, arrivals) into the session window so even quiet days have material. Tighten the recap prompt with a short-form branch when events are sparse.
status: todo
order: 375
epic: world
related: [275]
---

Even with `meta/llama-3.3-70b-instruct` (the env var swap that landed for #275), prod days with only 2-3 captured events still hit `[recap] sim-day N → degenerate output (0 chars: "")` and fall back to the deterministic walker. The pipeline is correct; the **input is too thin** for the model to write anything literary.

Two fixes in one slice.

## Slices

### Slice 1 — Widen ambient session-event sources

Append to the session window from currently silent paths:

- `need_low` crossings (the perception event already fires; mirror to session)
- Moodlet expirations with `|weight| ≥ 3` ("the warmth of breakfast had faded by mid-afternoon")
- Character spawned / despawned (`agent_spawned`, `agent_stopped`)
- Schedule_nudge that landed in a fresh room (the LLM moved itself successfully — recap-worthy *flavor* of routine)
- Object placement (when the user puts a new object in a room; characters notice next turn but the event itself is recap-worthy)

Each gets its case in `summarizeEventsForRecap` so the LLM sees them in human prose.

### Slice 2 — Sparse-day branch in the recap prompt

When the digest contains < 5 events, switch to a different prompt:

> *"Today was quiet. Write 2–3 sentences in past tense, named characters, no list formatting. Lead with the strongest beat (a moodlet, a routine moment, a small observation). It's OK to write less than a full recap when little happened."*

This avoids the model producing `{"recap": true}` or empty strings when it doesn't have material.

### Slice 3 — Tune the dense-day prompt

Add an explicit clause: *"if the events list is mostly ambient (room changes, routine), focus on the one or two beats with named-character action and skip the rest."*

## Acceptance

- A 3-event day (one post, one room change, one moodlet expiration) produces an LLM-written recap of 60–120 chars instead of falling back.
- Days with no events at all still produce the existing "Day N passed quietly" fallback.
- Bridge logs show `[recap] sim-day N → llm` strictly more often than before across a 5-sim-day prod run.

## Non-goals

- Multi-paragraph recaps.
- LLM "creative license" beyond the events list.
- Per-character recaps (one shared recap per session).

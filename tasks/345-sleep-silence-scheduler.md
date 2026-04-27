---
name: World — Sleep silence (scheduler-level per-character pause)
description: Replace the current "advance_sim 8h" trick with a per-character `asleep_until_sim_minutes` state on the heartbeat scheduler. Pauses only the sleeping character; the world clock keeps moving for everyone else.
status: todo
order: 345
epic: world
depends_on: [305]
related: [275]
---

Specified in [docs/design/follow-ups.md §1](../docs/design/follow-ups.md#1-sleep-silence--multi-character-compatibility).

Today's `use(bed)` chain calls `simClock.advance(8 * 60 * 60_000)`, jumping sim-time forward for the whole world. For solo Maya this is fine — the next heartbeat reads "Day N · 06:00" and she wakes up. For multi-character casts (where the storyteller / cards drive multiple agents through the day), it's wrong: other characters experience an instant 8-hour skip with no narrative explanation.

The replacement: per-character sleep state on `scheduler.attach(rec, { asleep_until_sim_minutes })`. Heartbeat skips turns while sim-time is inside that window; clears + emits a `woke_up` perception event when it crosses the threshold.

## Slices

### Slice 1 — Scheduler sleep state

- Extend `scheduler.attach(rec, opts)` to accept `asleep_until_sim_minutes` (number, total sim-minutes since origin).
- Per-character record in the scheduler tracks the threshold.
- Heartbeat tick: if `simClock.now().sim_minutes < threshold`, skip the LLM call. Reschedule next heartbeat at `(threshold - now) * cadence_ms_per_sim_min` real-time later (whichever is sooner than the regular alone-cadence).
- On wake (sim-time crossed): emit `(you woke at HH:MM)` perception event, clear the threshold.

### Slice 2 — `use(bed)` effect rewrite

- Replace the `advance_sim` effect kind with a new `asleep_until` effect:
  ```js
  { kind: "asleep_until", offset_sim_minutes: 8 * 60 }
  ```
- Handler in `gm.js` `use` verb resolves `simClock.now().sim_minutes + offset` and calls into the scheduler attach API.
- Remove `advance_sim` from objects.js bed effects.

### Slice 3 — UI surface

- AgentProfile drawer Vitals — add "asleep until ..." line under wellbeing badge when sleep state is active.
- The "asleep" indicator on the map avatar (small Z badge or muted opacity).

## Acceptance

- Maya emits `use(bed)` at sim-time 22:00. Her runtime stays attached but the heartbeat doesn't fire her LLM until sim-time 06:00 the next morning.
- A second character running concurrently DOES take turns during Maya's sleep window. The world clock advances at its normal cadence (not skipped).
- On wake, Maya's first prompt includes "(you woke at 06:00)" perception line.
- Profile drawer reflects "asleep until Day N · 06:00" while she's asleep.

## Non-goals

- Mid-night wake events (a noise wakes her early) — can be added later via a `wake_now` action emitted by cards.
- Sleep quality varying with bed type — one bed type for now.

## Risk notes

- Per-character cadence_ms in the scheduler should be respected even when sleeping — if the user changes cadence mid-sleep (60× → 1×), the wake-up should re-base. Easiest: store sim-minutes thresholds and recompute real-ms on each tick.
- Don't over-engineer multi-character sleep coordination. Each character sleeps independently; the storyteller can layer "everyone sleeps at the same time during a snowstorm" cards on top later.

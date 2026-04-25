# Animal Crossing — clock-driven activity timetables

Best public sources: [The Cutting Room Floor](https://tcrf.net/), and the ACNH datamining communities (Ninji's blog series reverse-engineered a lot of New Horizons; he published the village schedule logic).

---

## Daily routines are data tables, not random

Each villager has a personality type — Jock, Lazy, Snooty, Normal, Cranky, Peppy, Smug, Sisterly — which selects a **schedule template**: a 24-hour table of activities (sleep, walk around, sit on bench, visit another villager, work out, fish).

The exact activity in each slot is rolled at village-day-rollover (5 AM in most games) using a per-villager seed, and **pinned for the day**.

Within an activity, dialogue lines are pulled from buckets keyed by:

```
(personality, activity, weather, season, friendship-level, days-since-last-spoken)
```

## Wall-clock time drives everything

The console RTC ticks even when off. On boot the game computes deltas:

- weeds grew
- villagers moved away if you ignored them >29 days
- turnip prices changed twice a day

This is "schedule by reading the clock," not "schedule by running a simulation while powered off."

## Events are recurring date rules

Bunny Day = Easter algorithm. Fishing Tourney = first Saturday of month. Checked on save load and at midnight rollover.

Dialogue scheduling is event-based on top of the activity timetable. Triggers like:

- "first time meeting today"
- "you sent me a letter yesterday"
- "you have my requested item in inventory"

are checked at conversation start and prepend special lines to the bucket pull.

---

## Lessons for an LLM sandbox

- **Activity timetable per personality + clock-driven evaluation.** The LLM doesn't need to be running 24/7. When a player approaches a villager, you compute "what would I have been doing right now" from the timetable, then prompt the LLM with that context. Cheap, persistent-feeling, scales to many idle NPCs.
- **Per-day pin + per-day seed.** Roll at midnight, pin for the day. Lets the world feel different each day without re-deriving on every interaction. Keeps "what's NPC X doing" deterministic across the day.
- **Dialogue-bucket sharding by context.** Lines are organized by `(personality, activity, weather, season, friendship, …)`. The LLM's analog: a system prompt that's parameterized by these axes + retrieves from short-term memory similarly.
- **Wall-clock RTC means offline-correct state.** The game doesn't simulate while powered off; it reads time deltas and applies them. For an LLM sandbox: a character should resume from "you went offline at 18:00, you're back at 22:00, here's what would have happened" without simulating each missing turn.
- **Events as recurring-date rules.** A festival is a function of (date, year), not a queued state machine. Cheap, deterministic, easy to author.

---

## Sources

- [The Cutting Room Floor — ACNH](https://tcrf.net/Animal_Crossing:_New_Horizons)
- Ninji's *Inside Animal Crossing* blog series — see [Ninji on Twitter](https://twitter.com/_Ninji)
- Iwata Asks — *Animal Crossing: City Folk* interview

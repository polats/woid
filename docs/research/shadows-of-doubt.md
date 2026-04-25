# Shadows of Doubt — procedural citizens, schedule as ground truth

ColePowered Games' procedural detective sim, where every citizen has a backstory, an apartment, a job, friends, a regular bar, and a daily routine — all generated. The murder mystery layer reads off these schedules as *evidence*.

---

## Generation pipeline

ColePowered's DevBlog series (8, 13, 15, 23) documents a three-stage worldgen:

1. **City block grid** is generated.
2. **Interiors** are procedurally laid out room-by-room on top of a hand-curated tile set (DevBlog 13).
3. **Citizens** are "moved in" (DevBlog 15).

Each citizen is a record of:

- name, portrait genes, apartment ID
- employer ID + role, work hours, salary
- partner / family IDs, friend IDs
- **preferences** (favourite food, favourite drink, favourite hangout type)
- traits, a needs vector
- a **schedule**

Apartments and jobs are constructed first; citizens are bound to them; the social graph is generated last so links can be drawn between already-existing residents.

## Routine construction

A citizen's daily schedule is **assembled from blocks** rather than hand-authored:

```
Sleep(home)
  → MorningRoutine(home)
  → Commute
  → Work(employer)
  → LunchBreak(favourite_diner)
  → Work(employer)
  → Commute
  → Errand(grocery | laundry | …)
  → Leisure(favourite_bar | gym | park)
  → Sleep(home)
```

Errand and leisure slots draw from the citizen's preferences and social graph (visit a friend's apartment, go to a partner's workplace at end-of-shift). Each slot resolves to a concrete location ID at generation time.

## The pre-computation pivot

This is the most interesting architectural decision. Cole has been explicit in DevBlog 8 and DevBlog 31: the **original AI was almost entirely pre-computed** — routines were calculated once and replayed — which made anything spontaneous (witnessing a body, reacting to a fire alarm) prone to corrupting the schedule.

The current system is a hybrid:

- A **goal-based, "Sims-like stat" needs system** (eat, drink, sleep, hygiene, energy, social) layered on top of the pre-built schedule.
- Each in-game day still begins with a 10–15 second precompute that maps activities to time slots.
- During the day, **need thresholds and events can override** the next-planned action, and the schedule recomputes forward from the interrupt point.

Cheap, deterministic backbone + reactive utility layer.

## Update rate LOD

Roughly **95% of citizens at any moment are far from the player** and run on a low tick rate — only schedule advancement and presence updates. Citizens near the player or engaged in meaningful actions tick at full rate.

Memory-of-sightings (the green/red-line investigation graph: green = saw, red = familiar) is updated at full rate only when both endpoints are in the high-rate set.

## The murder mystery interaction with schedule

This is the load-bearing design point and what makes the architecture interesting for an LLM sandbox: **the schedule is the ground truth the player investigates against.**

A victim has an apartment, a job, friends, a regular bar. When they are killed, their schedule produces real **deltas in the world**:

- they don't show up at work (boss notices)
- they aren't home when their partner arrives (witness)
- their unfinished coffee is at the diner

Other citizens' schedules are **unchanged**, so their *sightings memory* of the victim is preserved — "I saw her last night at the bar" becomes evidence. Witnesses can also lie if their schedule placed them somewhere incriminating without an alibi; truth-telling is the default.

Crime-scene generation literally writes into the simulation (a body, displaced furniture, blood) and other citizens' perception loops pick it up if a line-of-sight check passes — including through lit windows from adjacent buildings.

## Tradeoff Cole called out

The pivot from pure pre-computation to needs-driven reactivity cost determinism (hard to debug "why did this NPC skip work today") but bought emergent stories — an NPC who saw something suspicious cuts their evening short and goes home, which may itself become a clue.

---

## Lessons for an LLM sandbox

- **Cheap precompute + needs-driven interrupts.** Don't run the LLM 24/7 simulating routine. Compute the day's schedule once at rollover (deterministic, fast); use needs and events to interrupt and re-plan.
- **The schedule is data the player can investigate.** This pattern *only works* if the schedule is queryable: "where would she normally be at 8pm?" An LLM in this world should be able to answer that as a structured query, not by guessing.
- **Schedules survive the agent.** Even after a character "dies" or stops, their schedule is the source of truth for what was supposed to happen — what witnesses expected. Keep schedules persistent and queryable independently of agent runtime.
- **Sightings memory is a graph the LLM can read.** The "I saw her last night at the bar" property is built by indexing perception events against schedule slots. Worth borrowing if we ever want murder-mystery / detective gameplay.
- **95% LOD ratio.** Most NPCs at any moment can be ticking at near-zero cost; only the player-adjacent or actively-engaged ones need full LLM cycles.

---

## Sources

- [DevBlog 8 — Simulating a City](https://colepowered.com/shadows-of-doubt-devblog-8-simulating-a-city/)
- [DevBlog 13 — Procedural Interiors](https://colepowered.com/shadows-of-doubt-devblog-13-creating-procedural-interiors/)
- [DevBlog 15 — Moving in the Citizens](https://colepowered.com/shadows-of-doubt-devblog-15-moving-in-the-citizens/)
- [DevBlog 23 — Generating Citizens, Pt 1](https://colepowered.itch.io/shadows/devlog/189689/shadows-of-doubt-devblog-23-generating-citizens-part-1)
- [DevBlog 31 — October Update](https://colepowered.itch.io/shadows/devlog/871652/shadows-of-doubt-devblog-31-an-october-update)
- [Wikipedia — Shadows of Doubt](https://en.wikipedia.org/wiki/Shadows_of_Doubt)

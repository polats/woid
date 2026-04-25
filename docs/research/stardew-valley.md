# Stardew Valley — hand-authored schedules + cascade overrides

Stardew is the canonical example of *hand-authored* NPC scheduling. There is no planner — every villager's day is a finite list of timestamps in a data file.

---

## Schedule format

Located in `Content/Characters/schedules/<NPC>.xnb`, decompiled to JSON/text. Reference: [Stardew Wiki — Schedule data](https://stardewvalleywiki.com/Modding:Schedule_data).

A real entry:

```
"spring_Mon": "610 SeedShop 16 18 2/800 Town 41 70 0 Abigail_Walk/
               1130 SeedShop 36 17 2 sit/1700 SeedShop 30 19 0/
               2200 SeedShop 8 9 0 sleep"
```

Each entry is `time location tileX tileY facing [animation]`.

## The schedule key cascade

The game looks for the most specific key first, falling back through general ones. Highest to lowest priority:

1. **Festival days** — entire schedule replaced by festival data in `Data/Festivals`
2. **Wedding day / birth events**
3. **Cutscene/event triggers** (`Data/Events`)
4. **Rain/snow alternates** — NPCs avoid outdoor work
5. **Friendship-heart variants** — `spring_Mon_4` for 4-heart friendship
6. **Marriage spouse schedules** — entirely separate file
7. **Default seasonal schedule** — `<season>_<dayOfWeek>`, then `<dayOfWeek>`, then `default`

This cascade is the reason a single NPC file can describe hundreds of distinct days without enumerating each one. Authors write a baseline once and only patch exceptions.

## Pathfinding

A* on the tile grid with **warp points** connecting maps.

The crucial trick: when an NPC is loaded mid-day, the game **back-computes where they should be** by replaying the schedule from 6:00 AM forward, then teleports them. This means NPCs are always "on schedule" even if the player never sees them travel.

If a path is blocked (player standing in a doorway), the NPC waits up to ~30s, then warps.

## Tradeoffs ConcernedApe discussed

In interviews (notably the GDC 2017 [Stardew Valley Postmortem](https://www.gdcvault.com/play/1024186/-Stardew-Valley-Postmortem-A)) Eric Barone has noted the rigid schedule:

- makes the world feel **reliable and learnable** — you *know* where Pierre is at 9 AM
- took thousands of lines of handwritten data
- adding new NPCs is O(n) authoring

He explicitly chose this over Radiant-AI-style emergence:

> I wanted players to be able to plan their day around villagers.

---

## Lessons for an LLM sandbox

- **Predictability has gameplay value.** Don't assume agents must be unpredictable. For some sandbox use cases (the player relies on Pierre being at the shop), predictability is the feature.
- **Cascade-of-overrides for routines.** A `default → seasonal → friendship-heart → festival` cascade lets you author a baseline once and only patch exceptions. Map this onto: "every dynamic-style character has a default routine, with overrides keyed by mood, relationships, in-world events."
- **Backfilling state from schedule (not simulating).** When a character is loaded after being offline, compute "where would they be now" from the schedule timetable — don't try to simulate the missed turns. Cheap and bug-free.
- **Hand-authored is OK at small scale.** For a curated village of ~15 NPCs, hand-written routines are fine and feel intentional. The LLM-generated schedule is a tool for *city-scale* sims; per-NPC bespoke routines remain valuable for named characters.

---

## Sources

- [Stardew Wiki — NPC schedule format](https://stardewvalleywiki.com/Modding:Schedule_data)
- ConcernedApe, [GDC 2017 — Stardew Valley Postmortem](https://www.gdcvault.com/play/1024186/-Stardew-Valley-Postmortem-A)
- [Stardew Wiki — full NPC schedule index](https://stardewvalleywiki.com/Modding:NPC_data)

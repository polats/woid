# Colony — strategy appendix

Loaded by the [SKILL.md](../SKILL.md) only when the agent needs depth. Skip on first pass.

## The need loop

Two needs drive everything: **food** and **energy**.

| Need | Decay rate (per sim-tick at 4 Hz) | Time to deplete from full | Restore source |
|---|---|---|---|
| `food`   | ≈ 0.021 | ~20 real minutes | `kitchen` tile (+35 per `eat`) |
| `energy` | ≈ 0.083 | ~5 real minutes | `bed` tile (+60 per `sleep`) |

Sleep + stress relief is more efficient per tile-trip than eat, so don't let energy decay below 30 — restoring from 30 → 100 takes one `sleep` verb; restoring from 5 (post-crash) takes the same verb but you've spent the interim being unproductive. Same logic for food.

## Stress

Moodlets accumulate negative weight from:

- Need crossings below 30 (`need_low:food` / `need_low:energy`) — `-4` each, lasts 30 minutes.
- Rejected actions (`rejected:<verb>`) — `-2` each, lasts 5 minutes.

Mood is `clamp(50 + sum(weights), 0, 100)`. Stress is the negative-side delta, smoothed. Above 80 the dupe enters `breaking` band — you should `sleep` ASAP, even if not at low energy. The utility-AI dupes follow the same rule.

## Skills

Slowly increase with use. Affect the brain's `scoreSkillMatch` multiplier — a 100% miner's `mine` candidate scores 1.0; a 50% miner scores 0.75. Specialization is a long-tail effect; don't try to optimize for it early.

## Contention with NPC dupes

In a co-op (you + 3 utility-AI dupes) game, the NPC dupes target the same ore deposits, beds, and kitchen you do. Concrete patterns:

1. **Ore vein contention.** All four NPCs default to the closest deposit, weighted by proximity. If you pick a far deposit, you'll have it to yourself. Net throughput about the same; psychological texture different.
2. **Bed contention.** Three beds, three or four dupes. Sleep when one is free; otherwise pick the second-closest bed.
3. **Kitchen monopoly.** One kitchen, low contention because eat is a short verb. No coordination needed.

## When to deviate from the obvious move

The brain's scoring is multiplicative: `need × proximity × skill × stress_relief`. A single 0 vetoes. Edge cases the brain will get wrong:

- **You're standing on an ore_deposit at low food.** The brain might prefer mining because proximity = 1.0 even though food pressure is high. Override: emit `eat` explicitly.
- **You just slept; energy = 100.** The brain de-prioritizes sleep. Good. But if your stress is high from another source (e.g. lots of recent rejected verbs), sleep again — stress is the lever.

## What the world will not do

- Won't punish AFK behavior. Decay continues but no permadeath.
- Won't randomly spawn threats. No combat, no fires, no diseases.
- Won't generate quests. Colony's mood is "industry, calmly."

## What the world might do (deferred hooks in the design)

- `breaker_tripped` ambient event with a stress moodlet — see [`docs/design/agent-harness.md` §7](../../../../../docs/design/agent-harness.md#7-deferred-hooks-with-triggers-for-activation).
- Lazy-materialized roster (Census pattern) when scaling past ~8 dupes.

Don't write strategy assuming these are live yet. When they ship, this doc updates.

# Kingdom Come: Deliverance II — GOAP under MBTs at 2,400 NPCs

Warhorse Studios' AI lead Matej Marko presented the architecture at GDC 2025 (Game AI Summit, *"Combining GOAP and MBTs to Create NPCs' Behaviors for Kingdom Come: Deliverance II"*). The split:

- **Modular Behavior Trees** specify the **desired state** ("be at the tavern, drinking, by 19:00") and orchestrate state transitions over time.
- **Goal-Oriented Action Planning** plans the **action sequence** to bridge current world state to desired state ("you have no mug → walk to bar → ask innkeeper → receive mug → walk to bench → sit → drink").

Designers author **what** an NPC should be doing across the day in a tree they can read. The planner solves **how** to make it true given dynamic conditions: door locked? tavern full? player blocked the path? It's a goal/plan separation almost identical in spirit to KCD1's CryEngine-based Smart Object + behavior system, but with MBTs replacing monolithic flowgraph behaviors and a real GOAP planner replacing handwritten preconditions.

---

## Smart Objects

As in The Sims, the world carries the verbs. A bench has a "Sit" smart-object slot; a tavern bar has "Order Drink"; an anvil has "Smith." NPC schedules reference smart-object **classes**, and at runtime the planner binds to specific instances (any free bench, the nearest unlocked door).

This is what enables a single authored "go drink at the pub" goal to play out at any tavern in the world.

## AI Level of Detail

Scaling from KCD1's ~550 simulated NPCs to KCD2's ~2,400 (roughly half concentrated in Kuttenberg) required tiered simulation. Warhorse's GDC Festival session *"Supporting Thousands of Simulated NPCs"* describes a multi-tier LOD:

| Tier | When | What's simulated |
|---|---|---|
| **Full** | NPC near the player | MBT + GOAP + animation + perception |
| **Coarse** | Off-screen but in-zone | Schedule advancement and presence tracking only; physics and detailed action sequences skipped |
| **Statistical / "ghost"** | Distant NPCs | Location and state are inferred from the schedule without ticking the planner — the NPC is "at the tavern" as a *fact*, not as a simulated actor |

NPCs hand off between tiers as the player moves. A streamed-in NPC's plan is reconstituted from its schedule rather than replayed from the beginning.

## Authored vs procedural daily cycle

Daily routines (wake → wash → work → eat → tavern → sleep) are **authored as schedule entries per NPC archetype**, with goals referencing smart-object classes plus time windows. Concrete unique NPCs (named characters) get hand-tuned overrides; generic NPCs (peasants, guards, merchants) inherit archetype schedules.

The procedural part is the **planner's solution at runtime**, not the schedule itself. This is the key tradeoff Bocan and Marko have stressed in interviews:

> Hand-authoring schedules is what makes the world feel curated; GOAP is what keeps it from breaking when the world shifts.

## Tradeoff explicit in the GDC talk

Pure behavior trees couldn't express "react sensibly when the planned door is locked." Pure GOAP gave undirected, soulless output. **MBTs-on-top-of-GOAP** let designers describe outcomes without hand-coding fallbacks, at the cost of a much harder debugging story — when an NPC does something weird, you have to inspect both the tree's chosen goal *and* the planner's chosen action chain.

---

## Lessons for an LLM sandbox

- **Three-tier AI LOD is non-negotiable past hundreds of NPCs.** For an LLM sandbox: **full** = LLM-in-the-loop near the player, **coarse** = lightweight rule-based mid-tier (schedule advancement only), **statistical/ghost** = "this NPC is at work because their schedule says so" with zero ticks.
- **Goal/plan separation matches LLM strengths.** The LLM is the goal-author ("be at the tavern by 19:00"). A small planner or scripted driver chains preconditions ("door locked → fetch key" or "blocked → re-route"). Don't ask the LLM to think every step.
- **Smart-object *classes* not *instances*.** Schedules reference "any tavern" not "tavern_id=42". Lets a single goal play out across the world; lets new locations slot in without rewriting schedules.
- **Authored backbone + planner adaptation.** The schedule itself is hand-curated for character voice; the planner handles dynamic adaptation. Pure procedural feels soulless; pure authored breaks under interaction.

---

## Sources

- GDC Vault — [*"Combining GOAP and MBTs for KCD II"*](https://gdcvault.com/play/1035576/Game-AI-Summit-Combining-GOAP) (Matej Marko, 2025)
- GDC Festival — [*"Supporting Thousands of Simulated NPCs in KCD/KCD2"*](https://schedule.gdconf.com/session/supporting-thousands-of-simulated-npcs-in-kcd-kcd2/915120)
- AI and Games Conference — [*"Supporting thousands of simulated NPCs in the open world of KCD2"*](https://www.aiandgamesconference.com/schedule/supporting-thousands-of-simulated-npcs-in-the-open-world-of-kcd2/)
- [GamesRadar — KCD horse-pathfinding interview](https://www.gamesradar.com/games/rpg/kingdom-come-deliverance-had-to-add-complex-pathfinding-for-just-2-npcs-that-owned-horses-if-you-want-to-do-this-feature-you-have-to-support-it/)
- Viktor Bocan (Design Director) interviews on Eurogamer, GameInformer, RPS

# RimWorld — ThinkTree, JobDriver, and a Storyteller that doesn't run NPCs

Tynan Sylvester's pawn AI is famously transparent because its three layers are cleanly separated:

- **ThinkTree** (decision) — picks *what* job to do
- **JobGiver / WorkGiver** (selection) — proposes *which specific* job and target
- **JobDriver** (execution) — actually runs the job as a sequence of `Toils`

---

## ThinkTree

Defined in XML (`ThinkTreeDef`), a ThinkTree is a hierarchy of `ThinkNode`s. The root (`thinkRoot`) holds `List<ThinkNode> subNodes`. Flow-control node types include:

- `ThinkNode_Priority` — evaluate children in declared order, take first valid
- `ThinkNode_PrioritySorter` — sort by dynamic priority then take first valid
- `ThinkNode_Random` — weighted random
- `ThinkNode_Conditional`
- `ThinkNode_SubtreesByTag` — lets mods splice subtrees into core trees via `insertTag`, e.g. `Humanlike_PostMain`

Evaluation returns a `ThinkResult { Job, SourceNode }`.

## JobGivers and WorkGivers

Leaves in the tree are `ThinkNode_JobGiver` subclasses with a `TryGiveJob(Pawn)` method that returns either a `Job` or `null`. The thread of execution stops at the first JobGiver that returns non-null.

**WorkGivers** are a parallel system used inside the `JobGiver_Work` node. They correspond to user-facing **Work Types** (Doctor, Cooking, Hauling, Cleaning…). `WorkGiver_Scanner` subclasses iterate Things in the map and score targets:

```csharp
WorkGiver_Scanner.GetPriority(Thing)
WorkGiver_Scanner.HasJobOnThing(Pawn, Thing)
WorkGiver_Scanner.JobOnThing(Pawn, Thing) → Job
```

The manual **Work Priorities** grid that the player edits is just an int matrix `pawn → WorkType → 1..4` consumed by `JobGiver_Work` to order WorkGivers.

## Schedule slots

Orthogonal to work priorities, each pawn has a 24-slot **Schedule** (Anything / Work / Joy / Sleep / Meditate). The slot **doesn't pick the job**; it gates which subtree of the ThinkTree is allowed to fire. `JobGiver_GetJoy` activates only during Joy or Anything when joy need is below threshold.

## Needs feeding job selection

Needs (`Need_Food`, `Need_Rest`, `Need_Joy`, `Need_Mood`, `Need_Beauty`, `Need_Comfort`, …) are each a float in `[0,1]` decaying per tick. They influence the tree mostly via **threshold-gated JobGivers**:

- `JobGiver_GetFood` runs only when `pawn.needs.food.CurLevelPercentage < threshold`
- `JobGiver_OptimizeApparel` runs only periodically
- mental-break checks sit higher in the tree than work

Mood (a meta-need) doesn't directly pick jobs but triggers `MentalStateGiver` nodes when it crosses break thresholds.

## JobDriver and Toils

Once chosen, `Pawn_JobTracker` instantiates the `JobDriver` class named in the `JobDef.driverClass`. Drivers `yield return` a sequence of `Toil` objects — atomic steps like:

- `Toils_Goto.GotoThing`
- `Toils_Reserve.Reserve`
- `Toils_Ingest.ChewIngestible`
- `Toils_Haul.StartCarryThing`

Each Toil has tick action, init action, end conditions, and fail conditions. This is RimWorld's equivalent of the Sims interaction state machine, but written in C# rather than tuned XML.

---

## The Storyteller is not the AI

A common confusion: **Cassandra Classic, Phoebe Chillax, and Randy Random do not drive NPC decisions.** They are world-level *event* generators — modeled explicitly on Left 4 Dead's AI Director per Sylvester — that decide *when* a raid, trade caravan, manhunter pack, or disease should fire.

They write into the world (raids spawn, weather changes), and pawns then react via their own ThinkTrees. The split is deliberate: the storyteller controls dramatic pacing; pawn AI stays mechanical and predictable so the player can trust it.

---

## Lessons for an LLM sandbox

- **Three explicit layers, not one big LLM call.** RimWorld separates "what kind of activity" (ThinkTree) from "which target" (WorkGiver scan) from "execute steps" (JobDriver). Our LLM is best at the upper two; lower step execution should be deterministic.
- **The schedule is a *gate*, not a *picker*.** A schedule slot saying "Joy" doesn't pick what to do — it allows the joy-related subtree to fire. Same shape works for our schedules: "9am — work" gates a `do_activity("work")` decision; the LLM still picks the specifics.
- **The Storyteller pattern is reusable.** Splitting *world events* (storyteller) from *agent decisions* (ThinkTree) means the LLM can author dramatic beats at the world level (a power outage, a guest arrives) without ever needing to drive an individual agent's foot placement.
- **Threshold-gated triggers.** Don't let an agent reconsider every turn. RimWorld's "only fire `GetFood` when food < 30%" pattern keeps decisions sparse and decisive.

---

## Sources

- [RW-Decompile / JobGiver_Work.cs](https://github.com/josh-m/RW-Decompile/blob/master/RimWorld/JobGiver_Work.cs)
- [RimWorldDecompiledWeb / JobDriver.cs](https://github.com/Chillu1/RimWorldDecompiledWeb/blob/master/Verse.AI/JobDriver.cs)
- [roxxploxx ModGuide — How Pawns Think](https://github.com/roxxploxx/RimWorldModGuide/wiki/SHORTTUTORIAL:-How-Pawns-Think)
- [CBornholdt RimWorld AI Tutorial](https://github.com/CBornholdt/RimWorld-AI-Tutorial/wiki/Part-1---Introduction)
- [RimWorld Wiki — AI Storytellers](https://rimworldwiki.com/wiki/AI_Storytellers)
- Tynan Sylvester, *Designing Games* (book) and various GDC talks

# Barotrauma — three-clock scenario architecture

FakeFish/Undertow's co-op submarine sim is famously a war-story machine: a session of Barotrauma typically produces at least one moment that ends up retold as anecdote. The architecture under the hood is more disciplined than the chaos suggests — and it's almost entirely **data-driven XML**, with the scenario-side C# acting as a thin DSL interpreter. Worth studying because woid wants the same shape: a session-bounded scenario layer that fires hand-authored beats over a persistent simulation.

The architectural keystone is **three loosely-coupled clocks**:

- **Mission clock** — the session-level objective (cargo run, salvage, monster hunt). Persistent state machine, win/lose, rewards.
- **Intensity clock** — runtime "AI Director" scalar recomputed every ~5s from crew health, hull integrity, flooding, fire, enemy presence. Drives *when* random events can fire.
- **Event clock** — local action-list inside one ScriptedEvent. `Label` / `GoTo` / `WaitAction`, branching via `ConversationAction.Options`.

Missions don't directly choreograph chaos — they nudge the EventManager (`MissionPrefab.TriggerEvent`) and let the Director decide pacing. The Director picks *when*; the Mission picks *what's eligible*; the ScriptedEvent picks *how it plays out*. Decoupling these is what keeps the system inspectable.

---

## Mission system

`Barotrauma/BarotraumaShared/SharedSource/Events/Missions/` ([dir](https://github.com/FakeFishGames/Barotrauma/tree/master/Barotrauma/BarotraumaShared/SharedSource/Events/Missions)). Subclasses one C# per type: `SalvageMission`, `MonsterMission`, `PirateMission`, `EscortMission`, `AbandonedOutpostMission`, `BeaconMission`, `CargoMission`, `CombatMission`, `EliminateTargetsMission`, `ScanMission`, `EndMission`. `Mission.cs` holds the shared state machine; subclasses override `DetermineCompleted()`.

XML attributes on a `MissionPrefab`: `type`, `identifier`, `commonness`, `difficulty`, `min/maxleveldifficulty`, `allowedlocationtypes`, plus localized `name` / `description` / `successmessage` / `headers` / `messages`. Rewards are factional — reputation distributed across origin location and opposing factions.

## Event Manager — the AI Director

[`EventManager.cs`](https://github.com/FakeFishGames/Barotrauma/blob/master/Barotrauma/BarotraumaShared/SharedSource/Events/EventManager.cs) computes:

```csharp
targetIntensity = ((1 - avgCrewHealth) + (1 - avgHullIntegrity) + floodingAmount) / 3f;
targetIntensity += fireAmount * 0.5f;
targetIntensity += enemyDanger;
```

`currentIntensity` lerps toward target — **rises in 25 s, falls in 400 s** (asymmetric: stress builds fast, calm earned slowly). An event fires only if `currentIntensity < eventThreshold` and `eventCoolDown <= 0`. The threshold *drifts upward* with `roundDuration`, so even a placid run eventually gets shaken — no dead sessions.

Selection is weighted random over [`EventSet`](https://github.com/FakeFishGames/Barotrauma/blob/master/Barotrauma/BarotraumaShared/SharedSource/Events/EventSet.cs)s filtered by biome, `LevelType`, `LocationTypeIdentifiers`, `Faction`, difficulty, and `MinIntensity`/`MaxIntensity`. Sets are nestable (a parent picks N children); flags `OncePerLevel`, `Exhaustible`, `PerRuin/PerCave/PerWreck`, `IgnoreCoolDown` give authors fine pacing knobs.

## EventActions — the scripting DSL

[`EventActions/`](https://github.com/FakeFishGames/Barotrauma/tree/master/Barotrauma/BarotraumaShared/SharedSource/Events/EventActions) contains ~70 verbs in three groups:

- **Effects** — `SpawnAction`, `ConversationAction`, `MissionAction`, `MoneyAction`, `ReputationAction`, `StatusEffectAction`, `AfflictionAction`, `TeleportAction`, `CombatAction`, `ModifyLocationAction`, `EventLogAction`.
- **Predicates** — `Check{Affliction,Condition,Item,Mission,Money,Objective,Reputation,Talent,Visibility}Action`, `SkillCheckAction`, `RNGAction`.
- **Flow** — `Label`, `GoTo`, `WaitAction`, `TriggerEventAction`, `BinaryOptionAction`, `OnRoundEndAction`, `SetDataAction`/`CheckDataAction` (event-local kv state).

`ScriptedEvent.cs` validates Label/GoTo wiring at load time. `SpawnAction` uses `SpawnLocation` (MainSub, Outpost, Cave, Wreck, Ruin) and `TargetTag` for later reference. `ConversationAction` uses `SpeakerTag` (no auto-personality lookup — speakers are explicitly tagged).

## Mission triggers and chains

Missions chain. `MissionPrefab.TriggerEvent` (nested struct) lets a mission fire an event by `id` + `state` + `delay`. `TriggerEventAction` lets one event fire another. `MissionAction`/`MissionStateAction` can advance another mission's state. State propagates through `SetDataAction`/`CheckDataAction` (string keys persisted on the Event/Mission) and tags on spawned entities — no direct C# coupling.

## NPC flavor without a trait system

Barotrauma has **no personality trait system**. Flavor comes from `Job` (Captain/Engineer/Mechanic/Medic/Security/Assistant), per-job skill rolls, faction reputation, and `Affliction`s (drunk, concussed, husk-infected — these *do* gate dialogue via `CheckAfflictionAction`). NPC dialogue lines live in `Content/NPCConversations/*.xml`, indexed by job + situation tags (`Idle`, `Wounded`, `OrderGiven`), so reactions feel personal without per-NPC state.

## Why emergent stories actually work

- **Asymmetric intensity decay** (25 s up / 400 s down) guarantees *valleys* between peaks — players remember the calm, then the shock.
- **Threshold drift** forces eventual events even on a quiet run → no boring sessions.
- **Independent clocks** mean a salvage objective, a hull breach, and a husk conversation can collide because nothing serializes them. Collision is where the war stories come from.
- **Tag-based targeting** (`TargetTag`, `SpawnPointTag`) means the same ScriptedEvent reads as a different story depending on what got tagged — same script, many stories.
- **Heavily hand-authored content + small verb DSL.** Freshness comes from large pools, intensity-aware gating, and `Exhaustible` / `OncePerLevel` flags — not procgen prose.

---

## Lessons for an LLM sandbox

- **Three clocks, not one.** Separate session arc (mission), pacing director (intensity scalar), and per-card action list. Storyteller picks *what*; director picks *when*; action list defines *how*.
- **Intensity as a single scalar with asymmetric lerp.** Cheap, legible, drives pacing without per-card heuristics. Compute from world state (conflict count, low-mood characters, scarce resources); rise fast, fall slow.
- **EventSet-style filter+weight.** Cards declare scene/faction/intensity-window/`oncePerSession`/`exhaustible`. The director is dumb — filtering does the work.
- **Tag-based targeting over hardcoded refs.** A card references `TargetTag` ("the_pilot", "the_visitor"), bound at fire time from world state. Same card → many stories.
- **Action DSL beats freeform output.** Give the LLM a small verb set (`Spawn`, `Converse`, `ModifyRel`, `EmitMoodlet`, `SetFlag`, `Check`, `TriggerCard`) so outcomes are inspectable and replayable. LLM fills *content* (prose, who-says-what), not control flow.
- **Skip personality traits if the model carries them.** Barotrauma uses Job + Affliction tags as the only flavor surface. We can use `about` + active moodlets the same way; no separate trait vector required.
- **Threshold drift to prevent dead days.** If sim-day rollover finds nothing eligible, lower the threshold so *something* fires. Asymmetric decay applies here too — quiet days inherit pressure into the next day.
- **Card chains via state keys, not direct calls.** `SetData("smuggler_met", true)` + `CheckData(...)` lets cards reference each other without coupling — the same primitive scales as the LLM authors new cards.

---

## Sources

- [EventManager.cs](https://github.com/FakeFishGames/Barotrauma/blob/master/Barotrauma/BarotraumaShared/SharedSource/Events/EventManager.cs)
- [EventSet.cs](https://github.com/FakeFishGames/Barotrauma/blob/master/Barotrauma/BarotraumaShared/SharedSource/Events/EventSet.cs)
- [ScriptedEvent.cs](https://github.com/FakeFishGames/Barotrauma/blob/master/Barotrauma/BarotraumaShared/SharedSource/Events/ScriptedEvent.cs)
- [EventActions directory](https://github.com/FakeFishGames/Barotrauma/tree/master/Barotrauma/BarotraumaShared/SharedSource/Events/EventActions)
- [Missions directory](https://github.com/FakeFishGames/Barotrauma/tree/master/Barotrauma/BarotraumaShared/SharedSource/Events/Missions)
- [MissionPrefab.cs](https://github.com/FakeFishGames/Barotrauma/blob/master/Barotrauma/BarotraumaShared/SharedSource/Events/Missions/MissionPrefab.cs)
- [BaroModDoc — RandomEvents](https://regalis11.github.io/BaroModDoc/ContentTypes/RandomEvents.html)
- [BaroModDoc — ConversationAction](https://regalis11.github.io/BaroModDoc/EventActions/ConversationAction.html)

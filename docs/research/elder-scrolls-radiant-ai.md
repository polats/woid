# The Elder Scrolls — Radiant AI / AI Packages

Bethesda's **AI Package** system debuted in Morrowind (primitive form), matured in **Oblivion** (2006) under the "Radiant AI" marketing name, was refined in **Fallout 3 / NV / 4** and **Skyrim**, and extended into **Radiant Quests** (procedural quest templates).

References: [UESP — Oblivion AI Packages](https://en.uesp.net/wiki/Tes4Mod:AI_Packages), [UESP — Skyrim AI Packages](https://en.uesp.net/wiki/Skyrim_Mod:AI_Packages).

---

## The AI Package data structure

Creation Kit field names:

```
Package {
  Type: Eat | Sleep | Wander | Travel | Find | UseItem |
        Patrol | Guard | Dialogue | Ambush | Sandbox | Escort
  Location: <cell or worldspace ref, or "near editor location", radius>
  Schedule: { startTime, duration, dayOfWeek }
  Conditions: [GetIsID == X, GetStage Quest >= 30, GetWeather, ...]
  Flags: MustComplete, MustReachLocation, AllowFalloutBehavior...
  TargetData: <ref or object type, e.g. "any chair">
  Priority: implicit by list order on the actor
}
```

## Selection algorithm

Each NPC has an *ordered* package list (from their template + faction + race + individually assigned). At each AI tick, the engine walks the list top-to-bottom and runs **the first package whose conditions evaluate true**. Higher-priority entries thus pre-empt lower ones.

Quest scripts can push override packages onto the stack at runtime (`AddScriptPackage`), which is how quests hijack NPCs into custom behaviors.

```
NPC "Adrian Decanius" packages:
  1. SleepInBed (22:00–06:00, condition: at home)        ← preempts
  2. EatAtInn   (12:00–13:00, condition: in town)
  3. WorkAtForge (08:00–18:00, condition: weather!=rain)
  4. WanderTown  (default, no conditions)                ← fallback
```

## Sandbox

A meta-package telling the NPC "use any nearby furniture / idle marker." This is what produces most "lived-in town" ambient behavior in Skyrim — patrons sitting at tavern tables, blacksmiths walking to anvils.

## Fallout 3/4 evolution

Same core, plus **"Procedural Patrol"** packages with linked patrol-path nodes. In Fallout 4, settlement NPCs use a **work-object** advertisement system (similar to Sims object-broadcasts) layered on top.

---

## Famous failures

These are the cautionary tales every NPC system designer should know.

### Oblivion "NPCs killing each other for forks"

During pre-release, a Skingrad NPC's "Find Food" package selected a fork owned by another NPC. The owner's "Defend Property" package triggered combat. Bystanders' faction-aggression packages cascaded.

Whole towns depopulated.

The fix: heavy condition tightening and removing ownership-as-trigger-for-violence. Discussed by Emil Pagliarulo, GDC 2008 lineage and in Game Informer interviews.

### "The Bloodthirsty Adventurer"

An NPC scripted to wander caves had no "flee" package and infinite respawn aggression — emergent murder hobo. Cut.

### Skyrim's "Adoption-via-package collision"

Adopted children whose `home` cell got overwritten by quest packages would teleport to the wrong house each load.

---

## Tradeoffs Bethesda devs discussed

Pagliarulo, Bruce Nesmith — see *"Skyrim's Modular AI"* GDC 2012, [GDC Vault](https://www.gdcvault.com/play/1015898).

- The package system is **powerful** — one shopkeeper template covers 80% of cases.
- It is **brittle under emergent interaction**.
- They explicitly **reduced** Radiant AI's autonomy between Oblivion and Skyrim — fewer needs-driven actions, more designer-pinned packages — because emergence was producing more bug reports than wonder.

---

## Lessons for an LLM sandbox

- **Priority-ordered condition stacks scale to thousands of NPCs cheaply.** The same pattern works for any agent system: ordered list of packages, first one whose conditions evaluate runs.
- **Emergent multi-NPC interactions are the failure mode you cannot author your way out of.** Always have a "veto" condition layer (`NoCrime`, `NoLeaveCell`, `RespectQuestState`) that quest scripts and the engine can toggle. **The single most important lesson from Bethesda: the more autonomous your agents, the more bulletproof your veto layer must be.**
- **Tools matter as much as runtime.** Modders extending Skyrim for 14 years is itself the proof. If we ever want users authoring NPCs, the tooling is half the work.
- **Reduce autonomy when emergence becomes net-negative.** Bethesda reduced Radiant AI between Oblivion and Skyrim for a reason. Pin behaviors when emergence stops being a feature.
- **Fork murder is a real category of bug.** Whatever ownership / property semantics our world has, model the pathological cases first.

---

## Sources

- [UESP — Oblivion AI Packages](https://en.uesp.net/wiki/Tes4Mod:AI_Packages)
- [UESP — Skyrim AI Packages](https://en.uesp.net/wiki/Skyrim_Mod:AI_Packages)
- [GDC 2012 — *"Skyrim's Modular Approach to Level Design"*](https://www.gdcvault.com/play/1015898)
- Emil Pagliarulo & Bruce Nesmith interviews (Game Informer, Reddit AMAs, GDC postmortems)

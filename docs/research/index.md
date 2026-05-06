# Research — agent worlds, schedules, and persistent multi-user spaces

Reference notes used while designing the next phase of woid (rooms, objects, schedules, NPC routines). Most of these are *traditional* games — the patterns that have been load-tested by millions of players for decades. A handful are LLM-era projects, treated mostly as cautionary tales.

The doc set is organized in three buckets:

## Game AI architectures

The proven, non-LLM design patterns for autonomous NPCs.

- [Foundational patterns: GOAP, Behavior Trees, Utility AI, HTN](#/docs/foundational-ai-patterns)
- [The Sims — Smart Objects + needs](#/docs/the-sims)
- [RimWorld — ThinkTree + JobDriver + Storyteller](#/docs/rimworld)
- [Kingdom Come: Deliverance II — GOAP under MBTs at 2,400 NPCs](#/docs/kcd2)
- [Shadows of Doubt — procedural citizens, schedule-as-investigation](#/docs/shadows-of-doubt)
- [Stardew Valley — hand-authored schedule files + cascade overrides](#/docs/stardew-valley)
- [The Elder Scrolls — Radiant AI / AI Packages](#/docs/elder-scrolls-radiant-ai)
- [Battle Brothers — durable identity as the story engine](#/docs/battle-brothers)
- [King of Dragon Pass / Six Ages — event cards as systemic narrative](#/docs/king-of-dragon-pass)
- [Mood systems — event-driven affect across shipped games](#/docs/mood-systems)
- [Barotrauma — three-clock scenario architecture](#/docs/barotrauma)
- [Fallout Shelter-likes & the Severance pitch — 2024–2026 genre survey](#/docs/fallout-shelter-likes)

## Persistent multi-user worlds

How metaverse / virtual-space platforms architect rooms, sync, and user state.

- [Gather.town — 2D tile worlds, hybrid WS+RTC](#/docs/gather-town)
- [Habbo Hotel — 25 years of persistent isometric rooms](#/docs/habbo-hotel)
- [Mozilla Hubs — open-source 3D, why hosted sunset](#/docs/mozilla-hubs)
- [Animal Crossing — clock-driven activity timetables](#/docs/animal-crossing)
- [Other social worlds: VRChat, Spatial, Club Penguin, Toontown](#/docs/metaverse-platforms)

## LLM-era prior work

What experimenting with LLMs as NPC brains has and hasn't validated.

- [Generative Agents (Smallville) and AI Town](#/docs/llm-agent-prior-work)

## Infra & pipeline research

Notes on model selection, deploy patterns, and pipeline tradeoffs for
the asset-generation side of woid (avatars, T-poses, 3D meshes, rigs,
animations). Captured during build-out of the Assets tab and the
self-hosted Cloud Run NIMs.

- [T-pose generation: model landscape](#/docs/tpose-generation-models)
- [Spells — VFX research (schema strictness + modern Three.js refs)](#/docs/spells-vfx)
- Pre-baking NIM caches — research notes — `../google-cloud/gemma-4-self-hosted/WARM-NIM-CACHE-RESEARCH.md`. Companion to `WARM-NIM-CACHE.md`; covers the three failure modes our derived-image build was hitting and the GCS-FUSE alternative.

---

## Top architectural patterns to take into woid

The same ideas keep recurring across all of these references:

1. **Put the verbs on the world, not in the prompt.** Smart-object affordances (Sims), wired furni (Habbo), advertised utilities — the world tells the agent what's possible. This bounds the LLM's action space and makes new content additive.

2. **Separate "what do I want" from "how do I get it."** ThinkTree → JobDriver (RimWorld), MBT → GOAP (KCD2), AI Package → low-level animations (Skyrim). The LLM is well-suited to the upper layer (goal selection, narrative); a planner or scripted driver is well-suited to the lower (collision-free execution).

3. **Pre-compute the schedule, react with needs.** Shadows of Doubt's pivot from pure pre-computation to backbone-plus-needs is the cautionary tale. Animal Crossing's "compute what you would have been doing now" from a timetable + clock + per-NPC seed is the pattern.

4. **Cascade-of-overrides for routines.** Stardew's `default → seasonal → friendship-heart → festival` cascade lets you author a baseline once and only patch exceptions. This is how you avoid authoring 365 schedules per NPC.

5. **Veto layer between LLM and engine.** Bethesda's Radiant AI murdered NPCs over forks in pre-release Oblivion. Every LLM-emitted action passes through a hard-coded condition gate (`NoCrime`, `RespectQuestState`, `NoLeaveRoomIfDoorLocked`) before execution. Emergence is always trying to murder NPCs over forks.

6. **Decay for biology, events for psychology.** The cross-game survey of mood systems is unanimous: hunger/energy decay over time, but mood/stress/morale is the *sum of recent events with weights and durations*. Moodlets, not a bar. RimWorld's Thoughts, CK3's Stress, Sims 4 Emotions, PZ Moodles all share this shape.

7. **Durable identity is the story engine.** Battle Brothers, M&B, Wildermyth, Shadow of Mordor's Nemesis — emergent narrative comes from characters whose persistent traits, scars, and relationships *accumulate visibly*. Decay needs aren't story; they're pressure. Story is what the player remembers about *this specific character*.

8. **Hand-authored content + systemic selection.** King of Dragon Pass's event-card pool is the cleanest demonstration: ~500 written cards picked by a small ranker over world-state predicates feels hand-crafted because every word *was* hand-crafted. The system decides *when*; humans decide *what*.

## Top anti-patterns to avoid

Two appear repeatedly:

1. **One process per room / per agent.** Hubs, early Habbo, MMO-era designs converged away from this. Use a worker pool with cooperative ticks; rooms and agents are objects, not processes.

2. **Bundling state, media, and assets into one stack.** Mozilla Hubs sunsetted its hosted service largely because each layer (state, media, assets) has different scale curves. Separate them from day one — SFU to LiveKit/mediasoup, assets to S3+CDN, state in your own service — so each can scale or be outsourced independently.

---
name: World phase 5 — LOD tiers, SLM routing, and cap-and-shard rooms
description: Scale to hundreds-to-thousands of NPCs without burning the inference budget. Three tiers: full LLM, coarse rules, statistical ghost. Cognitive Controller gates LLM calls. SLM/frontier routing. Per-room caps with sharding.
status: todo
order: 265
epic: world
---

Depends on #225, #235, #245, #255. Premature LOD is the classic trap — you can't tier behaviors that don't exist yet. By here we have a verb set, schedules, smart objects, and relationships that are all amenable to tiering.

Research case (see `docs/research/llm-agents-2025-2026.md` §1.1 PIANO, §3.1 NVIDIA ACE, §6 hybrid routing; `docs/research/kcd2.md` AI LOD; `docs/research/metaverse-platforms.md` cap-and-shard):

- KCD2 scaled from 550 to 2,400 NPCs by adding a coarse-tier and a statistical-ghost tier on top of the same behavior tree backbone.
- Project Sid's PIANO architecture demonstrated 1,000-agent runs by gating LLM calls through a Cognitive Controller — most ticks resolve at cheap modules.
- NVIDIA ACE shipped on-device Qwen3-8B for production game NPCs in 2025 — proven that SLMs can carry the per-NPC inner loop with frontier escalation reserved for hard cases.
- Every social VR/metaverse platform converges on 25–100 concurrent per instance and runs many instances. Don't try to make one giant room work.

## Deliverables

### Three-tier LOD

- **Full** — NPCs in a room with a connected human player. Full LLM gate from #235 applies; subgoal memory active. Existing behavior.
- **Coarse** — NPCs in adjacent rooms or recently-watched rooms. Schedule + needs tick deterministically; no LLM calls except for cross-room interactions that cascade into observed rooms. Affordance scoring + utility-based verb selection only.
- **Ghost** — NPCs in unobserved parts of the map. Position and need vector advance via a closed-form integrator (no per-tick simulation). When promoted back to coarse/full, state is interpolated to "where they would be now."

Tier transitions are managed by the room server based on observer presence. A character's tier is a single field readable by the GM.

### Cognitive Controller / LLM gate v2

- Extends the simple gate from #235 with a learned classifier (small model, can be a prompted SLM) deciding whether a given trigger genuinely needs the frontier model or can resolve at the rules layer.
- Inputs: trigger type, NPC personality, current relationships present, mood, novelty score (is this a situation we've seen before?).
- Output: route to (rules) | (SLM) | (frontier).
- Track gate accuracy via a sampled audit: run 10% of "rules-routed" decisions through the frontier and compare; tune the gate when it diverges.

### SLM / frontier routing

- Add a SLM tier to the harness abstraction (#135). Default `claude-haiku` or `qwen3-8b` for the per-NPC inner loop, frontier `claude-opus` (or equivalent) only when the gate escalates.
- Per-character cost dashboard from #185 splits into SLM vs. frontier token columns.
- Configurable per-character in case some NPCs warrant the frontier always (the player's main companion) and others never (background extras).

### Cap-and-shard rooms

- Per-room cap of N NPCs (configurable, default 30). When full, new arrivals spawn into a sibling instance of the same room template.
- Cross-instance presence: a "the cafe is also full of people elsewhere" hint is surfaced in perception so the world doesn't feel empty when sharded.
- Room registry tracks `{ template_id, instance_id, occupants[] }`. Movement between instances is a transition through the GM.

### Ghost-tier integrator

- Closed-form advance for need vectors over arbitrary `dt`. Activity timetable resolves to "what would I have been doing at time T."
- On promotion back to coarse: needs are interpolated, current activity is computed from the timetable, position is set to the activity's location.
- Animal Crossing wall-clock pattern (see `docs/research/animal-crossing.md`): the agent should resume from "you went idle at 18:00, you're back at 22:00, here's what would have happened" without simulating each missing tick.

## Acceptance

- A simulation with 200 NPCs runs at <10% of the per-NPC token cost of phase-2 baseline, by virtue of most NPCs being coarse/ghost most of the time.
- Tier transitions are seamless: an NPC promoted from ghost to full picks up at the right place in their schedule.
- Per-room caps fire correctly; arriving NPCs route to a sibling instance and the cross-instance presence hint shows up in perception.
- The cost dashboard shows the SLM/frontier split; gate audit shows <5% disagreement between the rules layer and a sampled frontier check on routed decisions.
- 1,000-NPC stress test boots cleanly. Doesn't have to be playable end-to-end yet — just demonstrates that the architecture doesn't collapse.

## Non-goals

- Multi-server / multi-bridge horizontal scale. Sharding here is in-process across rooms; multi-process is a separate card.
- Learned routing models trained on real telemetry. The gate v2 is prompted, not trained. Move to trained routing only with quality data.
- World-model-based ghost simulation (Genie 3 style). Ghosts are closed-form advances of the existing schedule + needs system.
- Cross-instance NPC migration policies (load balancing) beyond "fill instance 1 first."

## Risk notes

- Tier-transition correctness is the highest-risk item. Bugs here look like NPCs teleporting, forgetting interactions, or duplicating themselves. Invest in property-based tests: "for any sequence of tier transitions, the NPC's externally-observable state is consistent with the schedule + needs at the current time."
- The gate accuracy tradeoff is real. Too aggressive → noticeable quality drops. Too conservative → no cost savings. Ship with the gate disabled by default and turn it on per-character once measured.
- Cap-and-shard "presence hints" can feel artificial if overdone. One line of perception text per neighboring instance, max.
- Don't refactor phases 1–4 to fit LOD assumptions until LOD is measured to need it. The whole point of doing LOD last is that the lower tiers reuse the same code paths.

# Haunted-house games — design precedent

A breadth-first survey of asymmetric-haunter and fear-system precedent for the haunted-house demo we're building on top of phases 1-5. Compiled 2026-04-25.

The pitch we're validating: 4-6 LLM-driven NPCs in a house, a human player ("the house") manipulates environmental objects to scare them out. Win condition: every NPC leaves. The player is a non-NPC agent emitting verbs through the same Game Master as the NPCs. Fear is a need; crossing a threshold swaps the NPC's active subgoal to "leave the house."

Companion to [llm-agents-2025-2026.md](llm-agents-2025-2026.md) and the per-game research files in this directory.

---

## 1. Ghost Master (2003) — the direct precedent

Sick Puppies / Empire Interactive. PC, Xbox, PS2. [Wikipedia](https://en.wikipedia.org/wiki/Ghost_Master) · [Mechanics wiki](https://gm-ce.fandom.com/wiki/Mechanics) · [TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/GhostMaster).

The single closest match in shipped games. You command a roster of haunters; they manipulate environment objects (doors, taps, electronics, weather) to scare mortals out of buildings. Layered model:

- **Belief** — gates whether powers register at all. Skeptics shrug off the first attempts; once primed, they break fast.
- **Terror** — active scare meter; threshold-crossing causes the mortal to flee. Decays if you stop pressing.
- **Madness** — a separate one-way meter; at threshold, mortals go irreversibly insane and stay in the level (perverse incentive to abuse).
- **Conscious / subconscious fear tags** — each mortal has personalized fears mapped to specific powers; matching is many times more effective.
- **Plasma** — economy resource: scares earn it, powers cost it. Forces a pacing loop.
- **Opposition** — priests, witches, mediums can banish your haunters.

**For woid:** validates threshold-flee, validates per-NPC fear vector. Cautionary lessons: (1) Belief gating is non-negotiable — without it, scares either always work (boring) or never work (also boring). (2) Avoid Madness-style "trapped forever" outcomes that perversely incentivize the wrong play. (3) The "play the environment, not a character" pattern maps perfectly onto our human-as-house verb harness.

---

## 2. Asymmetric-haunter video games

### Phasmophobia (2020, Kinetic Games)

[Sanity wiki](https://phasmophobia.fandom.com/wiki/Sanity) · [Hunt wiki](https://phasmophobia.fandom.com/wiki/Hunt).

Sanity is a 0-100% bucket draining from darkness, ghost events, and seeing teammates die. Each ghost has a hunt sanity threshold; once average team sanity drops below it, hunts trigger probabilistically. The Banshee variant uses target sanity rather than average — interesting precedent for per-NPC vs. group-level fear.

**For woid:** validates probabilistic firing once threshold is crossed (avoids deterministic "ding, switch goal" feel). Average-of-team is the precedent for cooperative-escape contagion.

### Friday the 13th: The Game (2017, IllFonic)

[Fear wiki](https://fridaythe13ththegame.fandom.com/wiki/Fear_and_Avoidance).

Counselor fear is proximity- and lighting-driven. **Fear has mechanical knock-ons that aren't just goal-swaps:** stamina regen drops, Jason's "Sense" power picks up scared counselors more easily, and **at high fear counselors mutter aloud** — an AI-leakage cue that gives Jason positional info.

**For woid:** the cleanest precedent for the information-warfare claim — fear *generates* observable signals the antagonist exploits. Note also: F13 has fear *decrease* near other counselors (huddle is safer). We chose the opposite (contagion). Both defensible — we're picking the haunted-house "never split up!" subversion.

### Dead by Daylight (2016, Behaviour Interactive)

[Wikipedia](https://en.wikipedia.org/wiki/Dead_by_Daylight) · [Postmortem](https://www.gamedeveloper.com/design/crafting-an-asymmetric-multiplayer-horror-experience-in-i-dead-by-daylight-i-).

Published design philosophy: "embrace asymmetry — build two different games that share a stage."

**For woid:** challenges the "fully unify the input layer" instinct. Conclusion: keep the **validator/GM unified** (same arbiter, same world-state mutation API), but **don't force the input layer to be symmetric** — the human's verbs come from a UI, the NPC's from a planner. That's fine.

### Bureau of Contacts (2024, Mirowin)

[Coverage](https://www.destructoid.com/bureau-of-contacts-imagine-phasmophobia-but-with-generative-ai-ghosts/). [Unverified shipping at scale.]

Advertises a generative-AI ghost — closest published commercial attempt at an LLM antagonist in this genre. Worth tracking; we may not be alone here for long.

---

## 3. Tabletop precedent

### Betrayal at House on the Hill (Avalon Hill, 2004; 3rd ed. 2022)

[Wikipedia](https://en.wikipedia.org/wiki/Betrayal_at_House_on_the_Hill) · [Haunt wiki](https://betrayalhouse.fandom.com/wiki/Haunt).

The "haunt phase" mechanic is structurally identical to threshold subgoal swap: the game runs in **exploration mode** until an Omen + dice trigger flips the entire match into **haunt mode** with a wholly different ruleset. Validates "fear → leave" as the satisfying climax of the round, not a footnote.

### Mansions of Madness 2nd Edition (Fantasy Flight, 2016)

The most architecturally relevant tabletop precedent for the unified Game Master. 1st edition required a human Keeper; 2nd edition replaced them with **the app**, which spawns creatures, gates events, narrates, and keeps state. Players + app share one world model. Direct support for our "GM validates verbs from both NPCs and the player through the same arbiter" pattern.

### Dread (Impossible Dream, 2006)

[Wikipedia](https://en.wikipedia.org/wiki/Dread_(role-playing_game)).

Jenga tower as fear. Two design lessons: (1) tension is *physically observable* — players see the tower tilt before it falls, foreshadowing the threshold. (2) Failure isn't a soft modifier; it's removal-from-play. **For woid:** the house UI should expose a per-NPC fear telegraph (RimWorld's "mood target" indicator pattern), and crossing the threshold should be a discrete, visible event.

### Nyctophobia (Pandasaurus, 2018)

[BGG](https://boardgamegeek.com/boardgame/249505/nyctophobia).

Hunted players wear blackout glasses; one player (the hunter) sees the whole board. **Information disparity *is* the horror.** For us: the player seeing the NPCs' `say` log isn't a bug — it's the dramatic engine. Asymmetric perception is a feature.

### Ten Candles (Cavalry Games, 2015)

[Wikipedia](https://en.wikipedia.org/wiki/Ten_Candles). Ten lit candles count down inexorably; characters die by the end. Validates the framing "tension monotonically rises; the question is who breaks first."

---

## 4. Single-player horror — fear / sanity systems

### Eternal Darkness: Sanity's Requiem (2002, Silicon Knights)

[Sanity wiki](https://eternaldarkness.fandom.com/wiki/Sanity) · [Sanity Effects](https://eternaldarkness.fandom.com/wiki/Sanity_Effects).

The canonical sanity meter. Drops when undead see you; below thresholds, fourth-wall-breaking effects trigger. Sanity here is **not a goal modifier — it's a perception modifier**: it changes what the player *sees* without changing what's true.

**For woid:** strong support for the perception-channel-vs-state-channel split. Hallucinatory effects belong in the perception event stream, not in world state.

### Amnesia: The Dark Descent (2010, Frictional)

[Sanity wiki](https://amnesia.fandom.com/wiki/Sanity) · [Game Developer deep dive](https://www.gamedeveloper.com/design/game-design-deep-dive-i-amnesia-i-s-sanity-meter-).

Frictional's published postmortem reveals the sanity meter was largely **placebo** — the meter telegraphs danger to drive *player* behavior (avoid the dark, don't stare at monsters), but the actual mechanical hooks are minimal. The deliberate ambiguity made players self-scare.

**For woid:** validates the "no truth validation on planted notes / fabricated audio" choice. Letting NPCs (or players) decide what's real, without backing it with hard mechanics, was a shipped, celebrated design.

### Call of Cthulhu RPG (Chaosium, 1981+)

[Sanity rules](https://cthulhuwiki.chaosium.com/rules/sanity.html).

Sanity is a depleting resource with **threshold-triggered behavior swaps**: lose 5+ in a single roll → temporary insanity, where the *Keeper* takes over the character's next action — phobias, flight, hallucinations. Three named tiers (temporary / indefinite / permanent). 40+ years of play-tested precedent for fear-as-need-with-threshold-triggered-subgoal-swap.

---

## 5. "You are the dungeon" management games

### Dungeon Keeper / DK 2 (Bullfrog, 1997 / 1999)

[Traps wiki](https://dungeonkeeper.fandom.com/wiki/Traps).

Place rooms, traps, lures; heroes path in and react to environment via **unit attributes** (flying creatures ignore pressure plates; some classes panic; gold piles produce mood effects). Validates "place objects, NPCs react via traits" as a shipped, scalable pattern that doesn't require per-NPC scripted reactions.

### Evil Genius / Evil Genius 2 (Elixir / Rebellion, 2004 / 2021)

[Morale wiki](https://evilgenius.fandom.com/wiki/Morale_(EG2)) · [Loyalty](https://evilgenius.fandom.com/wiki/Loyalty).

**Two-axis NPC state:** morale (immediate motive) and loyalty (long-term retention). They degrade at different rates and respond to different stimuli. Direct support for fear being a separate axis on the needs vector, not folded into "social" or "fun."

### Legend of Keepers (Goblinz, 2021)

[Steam](https://store.steampowered.com/app/978520/Legend_of_Keepers_Career_of_a_Dungeon_Manager/).

The most direct support for **"morale to zero → flee"** as a primary win path *parallel to* "HP to zero → kill". Heroes either die or break and run. Heroes with low morale **also take more damage** — fear compounds, doesn't just gate the exit. Validates a graded fear curve where the threshold is the climax but every step toward it has a smaller continuous effect.

---

## 6. The Sims 4 Paranormal Stuff Pack (2021)

[Wiki](https://sims.fandom.com/wiki/The_Sims_4:_Paranormal_Stuff) · [Carl's guide](https://www.carls-sims-4-guide.com/stuffpacks/paranormal/) · [Emotions guide](https://www.carls-sims-4-guide.com/emotions/).

Concrete data flow: ghost actions emit **events** → events apply **moodlets** (typed, timed buffs) → moodlets aggregate into **emotional states** (Scared → Terrified → Panicked) → states gate **autonomy weights** (Panicked Sims won't cook, eat, sleep effectively). "Scared" also accelerates bladder-need decay — emotion couples back into other needs.

**For woid:** validates the moodlet/event-channel pattern. Challenges the "subgoal swap" framing by demonstrating a continuous-bias model that ships at scale. Resolution: do both, layered (see Validation §2 below).

---

## 7. RimWorld and Crusader Kings — fear-as-need precedent

### RimWorld (2018, Ludeon)

[Mental Break wiki](https://rimworldwiki.com/wiki/Mental_break) · [Threshold](https://rimworldwiki.com/wiki/Mental_Break_Threshold).

The cleanest published analog. Pawns have a Mood scalar (sum of typed Thoughts) and a **per-pawn Mental Break Threshold** (default 35%, modified by traits like Steadfast / Nervous). Mood below threshold → mental break event: pawn drops their queue and enters an uncontrolled state (catatonic, berserk, sad wandering). **Three severity tiers** (minor / major / extreme) at different sub-thresholds.

Strong validation. Notable details to copy:

- **Per-pawn threshold** modified by traits — not a global constant.
- **Tiered severity** — not a single switch but a graded staircase.
- **Mood Target indicator** telegraphs to the player where mood is heading.

### Crusader Kings 3 (2020, Paradox)

[Stress wiki](https://ck3.paradoxwikis.com/index.php?title=Stress) · [Dev Diary 31](https://forum.paradoxplaza.com/forum/threads/ck3-dev-diary-31-a-stressful-situation.1399764/).

Stress has named levels (1-4) with mental-break events at each transition; each break offers Coping Mechanism traits that *permanently change* the character. Validates threshold-triggered transformation **with persistent post-break trauma** — an NPC who once broke down and fled the house should retain trauma the next session, not reset.

---

## Design validation summary

How the proposed haunted-house architecture holds up against this prior art. Each row is a specific design claim → verdict → resulting change to the plan.

| Claim | Verdict | Result |
|---|---|---|
| House is a regular character with an external harness emitting verbs | Mostly validated; DBD challenges full input symmetry | **Unify the GM/validator and world-state API. Don't force input symmetry — human's verbs come from UI, NPC's from planner.** |
| Fear as a need with threshold subgoal swap | Industry split — but threshold camp has the better precedent for our win condition | **Layer both:** continuous bias on action selection (Sims) + threshold-triggered subgoal swap (RimWorld/CoC) for the actual leave decision. |
| Perception events as separate channel from state perception | Strongly validated; conflating them is a known antipattern | **Append-only typed event stream per NPC, separate from world-state snapshot.** |
| No truth validation on fabricated notes/audio | Validated — Amnesia's published philosophy | **Keep it. NPCs decide what's real. Add a "credulity" trait so believers and skeptics react asymmetrically.** |
| Cooperative escape via relationship-aware contagion | Partial precedent (Phasmophobia averages, F13 inverts) | **Per-pair contagion weighted by relationship score. Avoid global aggregate. F13's de-escalation is the road not taken.** |
| Information warfare — player reads NPC `say` log and times scares | Closer to invention; tabletop GM advice is the closest analog | **Show only the `say` channel, not the planner's `thinking`. Bake in an NPC suspicion path: too-perfect timing eventually leaks "the house is listening."** |

---

## Specific design changes from this research

1. **Add `belief` / `credulity` to the personality trait set.** Ghost Master's clearest lesson. Without it, scares either always work or never work. A skeptic NPC's first scare-event registers as ~10% of nominal fear; each successful scare raises their belief by a small amount, ramping reception over time.

2. **Layer continuous + threshold.** Fear continuously biases speech length, movement willingness, and need-decay rates *below* the leave threshold. Threshold itself is a discrete subgoal swap. This is the RimWorld pattern and matches what every long-form precedent ships.

3. **Tiered severity, not a single switch.** Three named tiers from RimWorld + CoC: `jumpy` (fear 25, +10% need decay, slight speech jitter), `spooked` (fear 50, refuses to enter dark rooms, says "did anyone else hear that?"), `fleeing` (fear 75, drops everything, heads to the nearest exit). The named tiers are visible in the inspector.

4. **Per-NPC fear threshold modified by traits.** Skeptic gets +20 to threshold (harder to scare). Medium gets -15 (easier). Coward gets -25. Steadfast gets +30. Carries through the relationship-aware perception modifiers.

5. **Mood/fear telegraph in the UI.** RimWorld's Mood Target indicator. The player should see where each NPC's fear is *trending*, not just its current value, so they can time the cascade.

6. **Suspicion as a parallel meter.** New per-NPC `suspicion` need. Increments when scares happen too quickly after `say` events that mention the scare's target. At suspicion threshold, NPC's perception starts to surface "the house seems to be listening to me." This is a self-balancing pressure on the player's information warfare — Cthulhu-style "you cannot know without being known."

7. **Coping mechanism on first leave.** CK3 pattern. The first time an NPC crosses the leave threshold and exits, they get a permanent trait based on how they were broken. "Phone-traumatized" (high resistance to phone scares forever, but +10 baseline fear), "fridge-haunted," etc. Useful if/when haunted-house becomes a multi-session campaign.

8. **The house's verbs go through the GM with asymmetric latency budgets.** Player-driven scares should commit in <100ms (UI feel). NPC verbs can take 1-10s (LLM inference). The unified GM is fine; the asymmetric latency comes from the input layer, which DBD argues is correct.

9. **Don't ship `madness`.** Ghost Master's cautionary tale. No "trapped forever" state. Every NPC must always have a reachable leave path. Otherwise the player optimizes against the win condition.

10. **`say` is shown to the player; `thinking` is not.** Already true in our prompt-style split — confirms keeping the separation. Also: don't surface relationship-state edges in the player UI directly; let them infer from `say` traffic. Asymmetric information goes both ways.

---

## Sources

- [Ghost Master — Wikipedia](https://en.wikipedia.org/wiki/Ghost_Master)
- [Ghost Master Mechanics wiki](https://gm-ce.fandom.com/wiki/Mechanics)
- [Phasmophobia Sanity](https://phasmophobia.fandom.com/wiki/Sanity)
- [Friday the 13th: The Game Fear](https://fridaythe13ththegame.fandom.com/wiki/Fear_and_Avoidance)
- [Dead by Daylight asymmetric design — Game Developer](https://www.gamedeveloper.com/design/crafting-an-asymmetric-multiplayer-horror-experience-in-i-dead-by-daylight-i-)
- [Bureau of Contacts coverage](https://www.destructoid.com/bureau-of-contacts-imagine-phasmophobia-but-with-generative-ai-ghosts/)
- [Betrayal at House on the Hill](https://en.wikipedia.org/wiki/Betrayal_at_House_on_the_Hill)
- [Dread RPG](https://en.wikipedia.org/wiki/Dread_(role-playing_game))
- [Nyctophobia BGG](https://boardgamegeek.com/boardgame/249505/nyctophobia)
- [Eternal Darkness Sanity Effects](https://eternaldarkness.fandom.com/wiki/Sanity_Effects)
- [Amnesia Sanity deep dive — Game Developer](https://www.gamedeveloper.com/design/game-design-deep-dive-i-amnesia-i-s-sanity-meter-)
- [Call of Cthulhu Sanity rules](https://cthulhuwiki.chaosium.com/rules/sanity.html)
- [Dungeon Keeper Traps wiki](https://dungeonkeeper.fandom.com/wiki/Traps)
- [Evil Genius 2 Morale](https://evilgenius.fandom.com/wiki/Morale_(EG2))
- [Legend of Keepers — Steam](https://store.steampowered.com/app/978520/Legend_of_Keepers_Career_of_a_Dungeon_Manager/)
- [The Sims 4 Paranormal — Carl's guide](https://www.carls-sims-4-guide.com/stuffpacks/paranormal/)
- [RimWorld Mental Break Threshold](https://rimworldwiki.com/wiki/Mental_Break_Threshold)
- [CK3 Stress Dev Diary](https://forum.paradoxplaza.com/forum/threads/ck3-dev-diary-31-a-stressful-situation.1399764/)

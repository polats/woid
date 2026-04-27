# Mood systems — event-driven affect across shipped games

Almost every emergent-narrative game in the survey uses **decay** for biological pressure (hunger, energy) but **events** for psychological state. The pattern is consistent enough to have a name: *moodlets*. This doc collects the variations across RimWorld, CK3, The Sims, Battle Brothers, Project Zomboid, and Dwarf Fortress, and distills the shared shape.

---

## RimWorld — Thoughts → Mood → Mental Break

Tynan Sylvester's design rejects mood-as-decay explicitly. *Designing Games* and his RimWorld dev posts call decay-driven mood "chore-ification" — it turns a feeling into a maintenance task.

Instead, mood is the **sum of active Thoughts**, each entry being:

```
Thought {
  def:        DefName        // "InsultedByX", "AteRawFood", "SleptOutside"
  moodOffset: float          // -10 .. +10 typical
  duration:   ticks          // 0 = permanent until removed; commonly 24h–10d
  stage:      int            // some thoughts have severity tiers
  otherPawn:  optional Pawn  // for relationship-aware thoughts
}
```

The mood number (0..100) is just `50 + Σ thoughts.moodOffset`, clamped. Bands map to mental-break thresholds:

```
Inspired (95+) — bonuses, "inspired surgery" etc.
Happy            — baseline ok
Content
Stressed (~25)   — minor break possible (sad wandering)
Stressed (~15)   — major break (binge drink, smash thing)
Stressed (~5)    — extreme break (berserk, run wild, suicide attempt)
```

Thoughts are visible in the inspector — players can see *exactly* why a pawn is unhappy ("Slept on floor: -4, Insulted by Greg: -8, Saw stranger's corpse: -3"). This transparency is the load-bearing UI choice — it turns a number into a story.

## Crusader Kings 3 — Stress as accumulator

CK3 has no per-tick mood. Instead, **stress** rises when a character is forced to act against their personality traits. Compassionate character ordered to execute prisoners → +30 stress. Greedy character forced to give to a beggar → +15 stress.

Stress thresholds (level 1, 2, 3) trigger **stress events** — the character acquires a "coping" mechanism (a permanent trait): drunkard, drug addict, recluse, wrathful outbursts, paranoia. These are sticky — the only way to remove them is a separate event chain.

Two design points worth stealing:

1. **Stress is a budget for *acting against type*.** The game doesn't stop you from forcing a Compassionate king to torture; it just charges you. Over time the cost compounds into the king becoming, say, a paranoid drunk.
2. **Coping mechanisms are durable identity.** Stress turns into trait, trait into permanent flavor in every future event. The momentary feeling becomes character.

## The Sims 4 — Emotions replace mood

Sims 1–3 had mood as a decay scalar. Sims 4 deleted it and introduced **Emotions**: Happy, Sad, Angry, Embarrassed, Bored, Confident, Energized, Flirty, Focused, Inspired, Playful, Tense, Uncomfortable, Asleep, Dazed.

A Sim is in *one* dominant emotion at a time, computed from active **moodlets** (yes, the same word as RimWorld's). Moodlets come from environment, interactions, and need state. The emotion gates the available interactions: a Confident Sim can give a Pep Talk; an Inspired Sim writes better books; a Focused Sim does math homework faster.

The shift Sims 4 made is from **mood-as-bar** to **mood-as-state-tag**. The number disappears from the UI; the *named state* with its associated moodlets is what the player sees and what the AI keys off.

## Project Zomboid — Moodles as visible icons

PZ uses ~14 "moodles" — Hungry, Thirsty, Tired, Stressed, Bored, Sad, Panicked, Drunk, Sick, Wet, Cold, Hot, Pained, Heavy Load. Each has 4 severity tiers shown as icon stack on the HUD.

Moodles are computed from many sources: zombie sightings, time alone, recent reading, weather, weight, alcohol, injuries. A moodle at tier 3+ applies stat penalties.

Two PZ-specific traits:

- **Visibility-first UI.** No bars; just stacks of progressively darker icons. The player reads "Bored III + Sad II + Cold I" as a sentence about their character's state.
- **Moodles can be addressed by *flavor* actions.** Reading a comic clears Bored. Smoking clears Stressed if your trait is Smoker. Different solutions for different characters → identity expressed through coping.

## Dwarf Fortress — Thoughts and Stress

The most baroque variant. Each dwarf has a list of recent thoughts (`AteFineMeal`, `WitnessedDeathOfFriend`, `AdmiredEngraving`, `ReceivedWater`) decaying over weeks. Stress accumulates from negative thoughts.

Personality (extracted from a 30-axis Big Five-shape model per dwarf) modulates *which* events are positive or negative — a Loyal dwarf takes the death of a citizen harder; a Brave one shrugs off combat horror. High stress, sustained, leads to madness: Berserk, Melancholy, Insane, Stark Raving Mad.

The lesson DF teaches: **events aren't valenced universally.** The same `WitnessedDeath` event hits different dwarves differently because their `about` differs. This is exactly an LLM sandbox's strength.

## Battle Brothers — Resolve and combat-only ladder

Already covered in [battle-brothers.md](battle-brothers.md). The relevant detail: in-combat mood is a four-state ladder (Confident → Steady → Wavering → Breaking) driven by moment-to-moment events (ally falls, terror weapon, took a hit). Out-of-combat there is *no* mood — just durable traits and grudges.

The implication: psychological state can be *event-driven and short-lived*, with the long-term identity carried entirely by traits. Worth a thought for woid: maybe the moodlet system is short-term, and anything that sticks gets *promoted* to a trait.

---

## The shared shape

```
moodlet {
  tag:        string             // "insulted_by:bob", "saw_friend:alice"
  weight:     int                // signed; sums into mood
  added_at:   timestamp
  expires_at: timestamp | null   // null = until removed by event
  severity:   int (optional)     // tiered (PZ-style)
  source:     string             // "social", "environment", "biology"
  by:         pubkey (optional)  // for relationship aggregation
  reason:     string             // human-readable for prompt + UI
}

mood = clamp(baseline + Σ active.weight)
band = lookup(mood, [cheerful, steady, lousy, breaking])
```

Common rendering for the LLM:

```
Feeling lousy. Recently:
  - insulted by Bob (2h ago, fades in 22h)
  - room is messy (ongoing)
  - slept poorly last night (12h ago, fades in 12h)
```

## Cross-game comparison

| Game | Numeric mood? | Moodlet duration | Visible to player | Drives behavior via |
|---|---|---|---|---|
| RimWorld | yes (0–100) | hours to days | inspector list | break thresholds |
| CK3 stress | yes (0–300) | permanent until event | character sheet | event triggers |
| Sims 4 | no — named state | hours typical | HUD icon | gates interactions |
| Project Zomboid | tiered icons | varies, addressable | HUD stack | stat penalties |
| Dwarf Fortress | yes + personality-modulated | weeks | character info | madness thresholds |
| Battle Brothers | combat ladder only | the fight | combat HUD | morale checks |

---

## Lessons for an LLM sandbox

- **Moodlets, not a mood bar.** The bar is debt the LLM can't reason about. The list of recent moodlets *is* the prompt block.
- **Each moodlet is a story hook.** "Why is Alice off?" — the moodlet list answers it without inventing.
- **Personality modulates valence.** When an event would emit a moodlet, the *character's `about`* modifies its weight (or whether it fires at all). DF's pattern, easy to do with an LLM.
- **Promotion to traits.** Long-running or repeated moodlets ("frequently insulted by Bob" 5+ times in 30 days) should *promote* to a durable trait ("resentful of Bob") that lives in the character's persistent state. This is how short-term mood becomes long-term identity.
- **Visible UI without numbers.** Show the moodlet list. Show the band label. Don't show 0–100. The number is implementation detail.
- **Source tagging enables aggregation.** A `by:` field on a moodlet means relationship strength to character X is just `Σ moodlets where by==X`. Free relationship graph.

---

## Sources

- Tynan Sylvester, *Designing Games* (2013), chapter on emotion and reward
- [RimWorld Wiki — Thoughts](https://rimworldwiki.com/wiki/Mood)
- [RimWorld Wiki — Mental break](https://rimworldwiki.com/wiki/Mental_break)
- [CK3 Wiki — Stress](https://ck3.paradoxwikis.com/Stress)
- [Sims 4 Wiki — Emotions](https://sims.fandom.com/wiki/Emotion)
- [PZWiki — Moodles](https://pzwiki.net/wiki/Moodles)
- [Dwarf Fortress Wiki — Stress](https://dwarffortresswiki.org/index.php/Stress)
- Tarn Adams, [Dwarf Fortress dev posts on personality and thoughts](http://www.bay12games.com/dwarves/)

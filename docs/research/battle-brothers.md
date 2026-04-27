# Battle Brothers — durable identity as the story engine

Overhype Studios' tactical mercenary sim (2017) is one of the cleanest examples of emergent narrative produced by **persistent, visible identity** rather than a needs vector. There is no plot, no protagonist, no scripted arc. The player runs a warband for sometimes hundreds of in-game days, and a saga writes itself because each individual brother accumulates traits, injuries, history, and finally a death that the player remembers.

---

## What persists per character

Every brother is a tuple of:

- **Name + portrait** — generated once, never changes
- **Background** (1 of ~33: Hedge Knight, Cripple, Adventurous Noble, Witchhunter, Beggar, Disowned Noble…) — sets baseline stats *and* personality flavor in event triggers
- **Traits** — typically 1–3 per brother
  - *Positive*: Brawny, Iron Lungs, Tough, Athletic, Resilient, Determined, Lucky
  - *Negative*: Asthmatic, Hesitant, Craven, Drunkard, Dastard, Fragile, Hate (Greenskins / Undead / Nobles…)
  - Most are rolled at recruitment; a few can be **acquired in play** (e.g. Brave from surviving a hopeless fight, Hesitant from fleeing one)
- **Permanent injuries** — combat consequences that don't heal: lost eye (-ranged), broken nose (-initiative), cut hamstring (-action points), missing fingers, fractured skull. Each is shown on the portrait (eyepatch, bandage, scar).
- **Level + perk picks** — a build the player invested in
- **Equipment** — often a story in itself ("his great-grandfather's axe")

Critically: **the character sheet is open by default** during combat. The player sees the eyepatch, the trait list, the injury "Fragile from a wolf bite, day 47" every time they deploy this brother. Identity is *unavoidably visible*.

## Resolve and the in-combat mood ladder

Resolve (a stat) gates a four-state in-combat ladder:

```
Confident  → bonuses to hit & defence
Steady     → baseline
Wavering   → penalties stacking
Breaking   → flees the field, may panic-attack ally, may permanently gain Hesitant
```

Drops happen on triggers — adjacent ally falls, outnumbered, hit by terror weapon, low HP. Bravery boosts come from leader perks, banners, or a kill. The ladder is *event-driven*, not decay — exactly the moodlet shape we want for woid.

## Why the saga writes itself

Three reinforcing loops:

1. **Permadeath + costly replacement.** A brother who dies took dozens of contracts to level. Replacing him isn't free. The player anthropomorphizes the survivors because they *cost something*.
2. **Negative traits stay funny / annoying / endearing.** Drunkard auto-buys ale. Hate Greenskins triggers berserker bonuses against orcs. Fat fails morale on hot days. The trait keeps producing small recurring jokes, which is *the engine of attachment*.
3. **Ambient backstory events.** Periodically two named brothers will trigger a vignette: an argument, a shared drink, one teaching the other to read. These flip relationship state and sometimes traits. Hand-authored prose, systemically selected.

Tom Francis (PC Gamer) and dozens of LP authors have written essentially the same essay: *"my company became a soap opera I cared about more than the game's actual mechanics."*

## What the design refuses to do

- **No mood meter** — beyond the four-step combat ladder. The character's wellbeing is communicated through *events that happened to them*, not a bar.
- **No relationship graph UI** — relationships are inferred from event flavor. The vignettes mention them; nothing else surfaces them.
- **No alignment / morality stat.** A brother is "the kind of guy who" is shorthand the *player* maintains, not the game.

The minimalism matters. Putting a numeric "morale" bar on each brother would have flattened the saga into bookkeeping.

---

## Lessons for an LLM sandbox

- **Visible scars are story.** Every persistent change to a character — an injury, a trait gained mid-run, a grudge — should show up in the prompt *and* in the UI. Players invest in what they can see accumulating.
- **Costly replacement is what makes characters matter.** If new agents are free to spawn, none of them are precious. Even a soft cost (a long onboarding, lost relationships) makes the existing roster narratively load-bearing.
- **Acquired traits, not just initial ones.** The system should be able to *write* into a character's identity in response to events: `gained_trait: "Brave"` after surviving a desperate scene becomes a permanent prompt-block entry, not a moodlet that expires.
- **Event vignettes between two characters.** Pick two co-located characters at a low cadence, run a small generator for a relationship beat ("they argue about X", "they share a drink"), feed the outcome to both characters' memory + relationship graph. This is the cheapest source of perceived narrative density we could ship.
- **Reject the morale bar.** A three-line "feeling lousy because Bob insulted her, room is messy, slept poorly" is the right grain. Not a 0–100.

---

## Sources

- [Battle Brothers — official site](https://battlebrothersgame.com/)
- [Battle Brothers Wiki — Traits](https://battlebrothers.fandom.com/wiki/Traits)
- [Battle Brothers Wiki — Backgrounds](https://battlebrothers.fandom.com/wiki/Background)
- [Battle Brothers Wiki — Injuries](https://battlebrothers.fandom.com/wiki/Permanent_Injuries)
- [Battle Brothers Wiki — Resolve / Morale](https://battlebrothers.fandom.com/wiki/Morale)
- [Tom Francis, *"Battle Brothers is a turn-based RPG of impossible decisions"*, PC Gamer](https://www.pcgamer.com/battle-brothers-review/)
- Reddit /r/BattleBrothers — perennial "lost my favourite brother" threads as evidence of attachment loop

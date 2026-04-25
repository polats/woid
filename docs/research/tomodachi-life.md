# Tomodachi Life — Mii apartment sim, relationships as state machines

Nintendo, 3DS (2013 JP / 2014 WW). Sequel *Tomodachi Life: Living the Dream* announced for Switch 2 in 2026. Best public references: the game's [official site](https://tomodachi.nintendo.com/), data-mining write-ups on [The Cutting Room Floor](https://tcrf.net/Tomodachi_Life), and community wikis. Tomodachi Life sold ~6.7M copies — the most successful Mii-driven life sim Nintendo shipped.

---

## What it is

A single-island apartment building populated entirely by user-imported **Miis**. Each Mii has:

- **Personality** — picked at intake from a 4-axis questionnaire (Movement, Speech, Expression, Demeanor), producing 1 of 16 personality types.
- **Voice** — pitch/speed/tone configured separately, used by the in-game TTS that delivers all dialogue.
- **Preferences** — favorite/disliked food, color, clothing style, song genre.
- **Relationships** — per-Mii edges to every other Mii: friend / best friend / sweetheart / spouse, with a numeric closeness value.
- **Needs** — hunger, clothing, problem (a list of small grievances they want the player to resolve).

The player is a third-party concierge, not a controlled character. Most gameplay is approving or declining Mii requests ("can I confess to X?", "I want this hat") and watching emergent skits play out.

---

## Architectural choices worth borrowing

### Personality is a small enum, not a free prompt

16 personality types × the dialogue/animation system = combinatorial coverage with hand-authored content. Every line in the game is keyed by `(personality, situation, relationship-state, mood)`. There is no generative dialogue — everything is data-table lookup with TTS reading the result.

Lesson: a small finite personality enum that conditions retrieval is enormously cheaper than free-form per-NPC personality prompts, and the believability ceiling is *higher than expected* because animations and voice are personality-tagged too. For woid: the LLM can generate the *line*, but the **delivery** (animation, voice, gesture) should be a discrete tag on the personality.

### Relationships as explicit state machines

Two Miis don't just "like each other" by a number. They progress through named states:

`stranger → acquaintance → friend → best friend → crush → dating → engaged → married`

Each transition has a **trigger event** (often initiated by one Mii asking the player for permission) and unlocks new interaction types (sleepovers, dates, weddings, having a child). Breakups and rivalries are first-class transitions too.

Lesson: relationships in an LLM sandbox should not be a single closeness scalar. A typed state machine is far easier to author dialogue against and avoids the "everyone loves everyone the same amount" failure mode that emerges from cosine-similarity affinity scores.

### Apartment as room-grid

The building is a vertical grid of identical apartments, one per Mii. Each apartment has the same fixed layout (kitchen, bathroom, living area). Furniture is the customization layer; the geometry isn't.

Lesson: standardize the *space* and vary the *contents*. A building of N Miis is N tile copies; pathfinding, persistence, and rendering are a single template instantiated per Mii. For woid: a "home" type that's structurally identical across NPCs lets the world scale linearly in NPCs without per-Mii authoring cost.

### Events as scheduled probability draws

Every in-game day, a small number of "things that can happen" are rolled per Mii from a table conditioned on `(personality, mood, current relationships, items in apartment)`. Most days roll mundane events (Mii is hungry, Mii has a problem); occasionally a high-impact event (confession, fight, marriage proposal) fires.

Lesson: schedule isn't only "what am I doing right now" — it's also "what *should* happen to me today." A daily event-roll layered on top of an activity timetable produces narrative without an authored arc. This is the same shape as Animal Crossing's per-day pin (see [animal-crossing.md](animal-crossing.md)) but extended to social events, not just activities.

### TTS as the universal voice layer

Every Mii speaks via the same parameterized TTS, with per-Mii pitch/speed sliders. No voice acting; no recording costs; voice diversity is procedural.

Lesson: if voice ever gets added to woid, treat it as a TTS axis tied to the persona record, not a per-character voice asset. Same logic applies to portrait generation — parameterize, don't author.

### "Mood" is a 5-state visible enum

Each Mii has a visible mood face (happy, content, neutral, sad, angry) shown over their head. Mood biases what events roll, what dialogue lines are picked, and whether the Mii will accept invitations. It's coarse, observable, and player-legible.

Lesson: hidden continuous mood variables are hard for players to read. A coarse enum with visible UI ("this Mii is angry") makes the simulation legible and gives the LLM a clean bucket to condition on.

---

## What didn't work

- **No player avatar in the world.** Players sometimes wanted to live in the building. The game's strict "you are the concierge" framing limited identification with the world.
- **Same-sex relationships were not supported at launch.** Nintendo patched a workaround but never fully fixed it; the underlying state machine gendered the transitions. A reminder: relationship state machines should be authored gender-agnostic from the start.
- **Repetitive after ~20 hours.** Once players had seen each personality × relationship-state combination, the procedural events stopped surprising. The data tables were finite. An LLM-generated line layer over the same state machine is exactly the upgrade that fixes this.
- **No inter-Mii memory beyond the relationship state.** Miis don't remember specific events; they only remember the current relationship label. Conversations don't reference history.

---

## Lessons for woid

1. **A personality enum + LLM dialogue is the best of both worlds.** Hand-authored personality tags drive animation, voice, and event-roll probabilities; the LLM only generates the textual line. Far cheaper than "the LLM determines everything."
2. **Relationship state machines beat affinity scalars.** Type the edges between NPCs (`stranger`, `friend`, `rival`, `dating`) and gate behaviors on transitions. Dialogue authoring becomes tractable; emergent narrative still happens.
3. **Daily event-roll on top of the activity timetable.** Each in-game day, draw a small set of "what could happen today" events per NPC from a table conditioned on their state. Layered with the schedule pattern from [animal-crossing.md](animal-crossing.md), this is a complete drop-in narrative engine that costs ~zero LLM calls.
4. **Standardize spaces, vary contents.** Each NPC's "home" should be the same template instantiated; furniture is the customization. Authoring scales by template, not by NPC count.
5. **Make mood visible and coarse.** A 5-state mood badge above each agent is more useful than a hidden continuous variable. Players can read it; the LLM can condition on it; the simulation feels legible.
6. **Author the system gender-agnostic.** Don't hardcode social transitions to gendered dialogue or animations. Tomodachi Life shipped with this bug and never fully fixed it.

---

## Sources

- [Tomodachi Life official site](https://tomodachi.nintendo.com/)
- [The Cutting Room Floor — Tomodachi Life](https://tcrf.net/Tomodachi_Life)
- [Tomodachi Life Wiki](https://tomodachi.fandom.com/wiki/Tomodachi_Life_Wiki)
- Nintendo *Iwata Asks* — *Tomodachi Collection* (predecessor)

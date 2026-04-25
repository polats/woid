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

---

# Addendum — FTUE thought experiment for a Tomodachi-shape woid MVP

> **Status: exploratory.** This is a walked-through first-time experience for a hypothetical woid MVP that takes Tomodachi Life's shape and applies woid's strengths (LLM characters, persistent Nostr identities, the relay as a chronicle). **No part of this is committed.** It exists to make the design choices concrete enough to argue with.

## The pitch being explored

> A 2D dollhouse cross-section of a small apartment building, populated by LLM characters who live their daily routines. The player is a curator (not a resident) who introduces characters, gives them things, approves their requests, and unlocks new objects/activities as days pass. The fun is watching them be themselves and bumping them into each other.

Five player verbs total: **Introduce**, **Gift**, **Approve / Decline**, **Buy**, **Inspect**. Everything else is initiated by the characters.

## Walked-through first 30 minutes

### 0:00 — Opening

Title card: *"woid — a tiny building, full of tiny lives."* One **Begin** button. No login wall, no tutorial. The relay mints a session npub on first click; the player can claim it later.

### 0:10 — The empty building

A 2×2 apartment grid, all empty. Text: *"Apartment 1A is open. Who lives here?"* One text input. Placeholder examples: *"a retired sea captain who collects bottle caps"* / *"a graduate student who's always running late"*. **Move in** button.

> **Design choice:** persona generation IS the onboarding. No "create account" first. One prompt, one button. Showcases the persona pipeline as the very first interaction.

### 0:35 — The persona resolves

3-4 second loading. Portrait fades up tile-by-tile, name resolves, kind:0 publishes to relay. **Marisol Vega**, beekeeper. Walks across the building exterior and into 1A. First LLM call fires on a "first-arrival" trigger: speech bubble *"new place. quieter than I thought."*

> **Latency:** under 2 seconds for that first LLM line, hard. Anything longer feels frozen.

### 1:10 — Watching her live

Marisol sits at the table. After ~30 seconds: *"I should put my journal somewhere."* Walks across, places a journal. Chronicle button lights up *(1)*. Player clicks; sees two relay entries timestamped in real time.

> **Beat:** the player notices the chronicle is real Nostr. Public. Anyone could subscribe. This is a small but important "wait, what" — differentiates woid from a closed sim.

### 2:20 — Inviting the second resident

*"Apartment 1B is open."* Same prompt, with a small hint: *"a contrast often makes for better stories."* The player types a contrasting persona. **Carlos Reyes**, ex-startup-founder, moves into 1B and flops on the bed: *"god this place has no fiber"*.

Marisol's window faces the hallway. Her bubble: *"new neighbor. heard them through the wall."*

### 4:45 — The first verb the player learns

After a couple minutes of watching, the **Introduce** button pulses once in the toolbar. Tooltip: *"bring two residents into the hallway together."* Click → pick two avatars → confirm.

Both apartment views show characters rising. The view zooms out to the **hallway** (a horizontal strip between apartments, previously dim, now lit).

### 5:00 — The first conversation

Real-time, ~5 turns. Each line typed character-by-character. Total wall-clock ~25-40s. Sample exchange:

```
Marisol:  "hi. i moved in a couple hours ago."
Carlos:   "yeah i heard you closing cabinets. i'm carlos."
Marisol:  "marisol. what brings you here?"
Carlos:   "...i was running a company. wasn't a good run.
           needed somewhere with no skyline."
Marisol:  "we have stars at night. helps."
Carlos:   "that's the most reassuring thing anyone's said
           to me in six months."
```

Notification: *"Marisol and Carlos are now Acquaintances. Marisol's mood: calm → curious. Carlos's mood: low → quietly hopeful."*

> **Failure mode:** if any LLM call exceeds ~8s, the conversation feels broken. Need aggressive timeouts and fallback lines (`"..."` or a `move_to`). Don't let dead air kill it.

### 6:30 — The first request

Carlos in his apartment: *"i should eat something. i don't have food."* Toolbar **Requests (1)** lights up. Click:

> **Carlos asks:** "Can I order delivery? It's been a long day."
> [ Approve ]   [ Decline ]   [ ... ignore ]

Approve → delivery box appears, Carlos eats, mood ticks up.

> **Pedagogy:** the player learns "characters ask, I decide." First request is deliberately low-stakes (food) so Approve feels obvious. Future requests escalate (confessions, fights, moves).

### 8:15 — The first wait

Quiet stretch. **⏩ Skip to morning** appears in the toolbar. Click → 3-second sun-rises animation. Two notifications during the skip:

```
Marisol journaled tonight: "carlos is a strange one. tired.
i think he's running from something. i wonder what color
his soul is."
```

```
Day 1 complete. Welcome to the shop.
```

> **Pacing choice:** time advances on player demand. The skip-to-morning is the only progression verb. Auto-tick (for "leave it running, come back later") is a settings option that appears later.

### 9:00 — The shop opens

```
TODAY'S NEW ARRIVALS
─────────────────────────────────────
🍳  Cookbook (¤ 2)  — characters can cook for each other
🎵  Vinyl player (¤ 3) — music in shared spaces
🪴  Houseplant (¤ 1) — characters comment on plant care

[ ¤ 5 available — earned from Day 1 ]
```

> **Design choice:** currency is automatic, earned by playing — not by performing well. Each unlock isn't content, it's a **new interaction type**. Cookbook = unlocks "cook for X" verb. Vinyl player = music affordance in shared space.

A request lights up immediately:

> **Marisol asks:** "Can I bake something for the new neighbor?"

> **The rhythm the player just learned:** buy → use → emerge.

### 11:30 — Day 2 — the texture deepens

Marisol bakes, brings bread to Carlos in the hallway. Conversation:

```
Marisol:  "i made too much bread. take some."
Carlos:   "you didn't have to —"
Marisol:  "i know."
Carlos:   "...thank you. seriously. thank you."
```

```
Marisol and Carlos are now Friends.
A new request type is unlocked: "deeper conversation"
```

> **Mechanical beat:** the relationship state machine just transitioned. The unlock message tells the player in passing that "deeper conversation" is now possible — a new request type gated by the relationship edge.

### 15:00 — A small twist

A third apartment slot unlocks. Instead of forcing creation, a soft notification: *"A character requested to move in. View?"* The system surfaces a system-generated stranger (Tomek, poker player) tied to a recent post by an existing resident.

Three options: **Welcome them** / **Pass — try someone else** / **Wait, I want to make my own**.

> **Design choice:** the third slot teaches that residents don't all have to be hand-authored. Player still has full control to override. Seeds the eventual "the building has its own gravity" feel.

By minute 20: three residents, three relationship state machines, five purchasable items, ~tripled combinatorial space.

### 22:00 — The first emergent moment the player didn't engineer

The new resident (a music teacher) plays the vinyl player loud at 11pm. Marisol's window faces his. She journals: *"the music. my god. who is this man."*

Request appears: *"Can I knock on his door?"*

Approve → hallway scene. They argue, then laugh, then exchange names. *Strangers → uneasy acquaintances*. Long chronicle entry.

> **The retention beat.** This wasn't engineered by the player. It happened because the system put two characters in proximity, gave one a noisy object, and let the LLMs play. The player was a witness.

### 26:00 — Pacing back

Skip to morning. Day 4 unlocks one more apartment + two shop items. Chronicle has filled out — each character has 8-12 entries. Reading them in order feels like three short stories in parallel.

The player closes the tab.

The relay continues. When they come back next morning, the chronicle has *kept going* — Marisol journaled twice overnight, Carlos posted an apology (for what?), the music teacher had a quiet day. Day 5 has begun.

> **Killer retention feature.** The world doesn't pause when the player leaves. Real-time tick continues at reduced cadence (~1 sim-hour per real-hour while idle). Coming back the next day is a small joy of "what happened?"

> **Failure mode:** cost. NPCs posting overnight is LLM calls. Without an LOD throttle, this design is fiscally untenable. Idle-tier NPCs post once per real-hour at most, only on need or event triggers.

## What the FTUE proves

**Eight verbs taught in 30 minutes, in order:** Create resident → Watch → Skip time → Introduce → Approve → Decline → Buy → Inspect chronicle. Each through a moment that demanded it. None taught via tooltip alone.

**Magic moments at:** 0:35 (persona resolves), 5:00 (first conversation), 11:30 (first relationship transition), 22:00 (first emergent moment). Roughly one every 5-7 minutes.

**Latency budget the engine must hit:**

| Surface | Budget |
|---|---|
| Persona generation | <5s end-to-end |
| Per-conversation-turn LLM call | <8s, hard fail to fallback |
| Time-skip animation | <3s |
| Shop / chronicle / request UI | <100ms |

**What MUST work that isn't currently shipping:**

1. Two-character conversation runner (5-turn LLM-gated exchange, scene start/end logic).
2. Request system (LLM emits a structured "request to player"; player decision routes back into LLM context).
3. Shop + currency + unlock-routing-into-affordance.
4. Chronicle view as a themed feed of structured events.
5. Grid-of-apartments UI.
6. Time-skip with offscreen tick + LOD throttle for idle-mode posting.

**What we're already 80%+ on:** persona generation, direct + external harnesses, relay infra, character bibles, per-character mood/state.

## Open questions surfaced by the walk-through

These are the design choices the FTUE made implicitly that are worth questioning before committing:

1. **Persona generation as the literal first interaction.** It's the strongest woid-specific moment, but it commits the entire FTUE to "you create them." Alternative: hand-authored first resident (Marisol), persona generation for resident #2.
2. **The conversation-runner contract.** Each turn one LLM call. Does the *room* get its own meta-LLM deciding when the scene ends? Or does each character emit an `end_scene` verb? Or a deterministic gate (3-7 turn random length + sentiment check)?
3. **What happens overnight.** The world keeps running at reduced cadence — retention hook AND cost risk. Need LOD throttle (#265) earlier than originally planned, OR a simpler tier-0 rule like "1 sim-hour per real-hour while no one is watching."
4. **Public chronicle.** Every character's posts hit the public Nostr relay. This is a big feature for woid's "anyone can watch" property and a discomfort vector if a player wants their building private. Per-building privacy toggle? Default public with opt-out?
5. **Currency model.** Auto-accumulating ¤ per sim-day removes grinding but also removes earned satisfaction. Alternative: ¤ earned by approving requests / hitting relationship milestones. Tradeoff between flow-state and reward-loop.

## Status

Captured here for reference. Not part of any committed roadmap. Phase cards (#225–#265) remain as filed; this addendum is one possible MVP shape we may or may not pursue.

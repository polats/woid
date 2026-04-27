# Vertical slice — audience, loops, and Day 1–7

This doc grounds [storyteller.md](storyteller.md) in a specific player and a specific week. The architecture is right; the *texture* is not yet decided. This is the texture spec.

The earlier [Tomodachi-shape FTUE thought experiment](../research/tomodachi-life.md#addendum--ftue-thought-experiment-for-a-tomodachi-shape-woid-mvp) walked the first 30 minutes. This doc picks up from there — defines who the player is, the three loops they engage with, and what Day 1 through Day 7 look like with the storyteller architecture wired in.

---

## 1. Audience

We are building for the **narrative-sandbox cohort**: people who play (and re-play, for years) The Sims, Animal Crossing, Tomodachi Life, Stardew Valley, *Cozy Grove*, *A Little to the Left*. They overlap meaningfully with parasocial-media audiences (slice-of-life manga, *podcasts about other people's lives*, sim-Twitch streamers).

### What they love

| Pattern | What it looks like |
|---|---|
| **Daily check-in** | Open the app for 10 min, leave, return tomorrow. Not a 4-hour session. |
| **Parasocial attachment** | *"Cleo is having a rough week"* — characters as friends/pets/dolls. |
| **Low stakes, high warmth** | Mishaps are funny, not punishing. No game-over. |
| **Specific quirk** | A character has a *very specific* preference (only oat milk, hates Wednesdays). The specificity is the affection. |
| **Compounding investment** | Day 30 matters more than Day 1 because the characters have *history*. |
| **Curating, not driving** | Light agency — name them, gift them, witness them. Not steer them. |
| **Customization without grind** | Names, looks, soft preferences, room layout. Cosmetic > combat. |
| **Surprise charm-moments** | A villager wrote you a letter. A Mii sang you a weird song. |
| **Authored voice that feels personal** | KK Slider's lines. Tomodachi's TTS jokes. Sims pop-up notifications. |

### What bounces them off

| Pattern | Why |
|---|---|
| Punitive failure | Permadeath, hard losses, "you ruined everything." |
| Grim ambient mood | "Everyone is sad" loops are exhausting. |
| Stat sheets and bars | They want the *feeling*, not the dashboard. |
| Forced pace | "You must complete X by Y" — these audiences want to set their own clock. |
| Unfunny edginess | Tonal lapses kill the cozy contract. |
| LLM tells (em-dashes, lists, "I'm sorry but…") | This audience reads voice carefully. Slop is unforgivable. |
| Combat or conflict-as-mechanic | They will tolerate small interpersonal friction. They will not tolerate fighting. |

### Implications for our axes

This refines [storyteller.md](storyteller.md)'s tuning meaningfully:

- **The intensity scalar should be warmth-biased, not drama-biased.** Cards skew **70% mundane/cute, 25% mild interpersonal friction, 5% real drama.** The director's threshold drift exists to ensure *charm* doesn't go missing on quiet days, not to inject conflict.
- **No permadeath at default.** Departures yes — characters can travel, leave, retire. Death is reserved for edge cases (very old characters; user-initiated).
- **Promoted traits are usually *endearing*, not grim.** "Resentful of Bob" is rare. "Always offers tea first" is the norm.
- **Recap voice is journal-warm, not battle-report.** Every recap reads like a friend telling you about their roommates.
- **Customization is a first-class activity.** Editing `about`, choosing avatars, naming, gifting are *core gameplay*, not setup.
- **Specific preferences are content.** Each character should reveal 1–3 idiosyncratic preferences over Days 1–7 ("really only likes overcast weather", "names every plant"). Stored on `about`. Triggered on demand by the LLM, surfaced via cards.

---

## 2. The three loops

```
Session loop (daily, 5–15 min)
  ─► open app → read recap → witness 1–2 moments → respond to 0–2 requests → close app
   ↳ delivers: a story beat, a smile, a thread to wonder about overnight

Weekly loop (3–7 days)
  ─► relationships transition → preferences accumulate → first arc resolves → first trait promotes
   ↳ delivers: the feeling that the world has *moved* since you arrived

Long loop (weeks–months)
  ─► characters grow into themselves; arrivals/departures; objects you've placed have history
   ↳ delivers: irreplaceability — *this* world is yours
```

### Time model

**Hybrid wall-clock + skip-to-morning**:

- Default: **1 sim-day = 1 real-day**, sim-day rollover at the user's local 5 AM (Animal Crossing's pattern). World ticks at low LOD overnight; recap generates at rollover and is waiting for the user when they open the app.
- Optional: **skip-to-morning button** — for users who want to binge or are catching up. Advances time, runs the rollover.
- Power-user mode: user-configurable cadence (1 sim-day = 30 real-min for a "weekend with the building" pace).

Wall-clock by default keeps the parasocial *something happened while I was away* feel that AC nailed. Skip-to-morning is the relief valve.

### Currency loop (light)

Borrowed from Animal Crossing / Tomodachi, made deliberately *non-grindy*:

- **¤ accrues automatically per sim-day** (a small allowance, e.g. 3¤/day).
- **Milestone bonuses** at relationship transitions, recipe unlocks, festival days.
- The shop sells **object types** (cookbook, vinyl player, houseplant, journal, kettle…) that, when placed, **expand the affordance space** — characters can do new things, new cards become eligible.
- No gating of *people*, only *interactions*. You never can't talk to someone because you're poor.

Currency is the player's investment surface. Buying a cookbook isn't loot — it's *adding a verb to the world*.

---

## 3. Tonal calibration

### Positive-skew distribution

Across all card emissions and moodlet emissions:

```
~70%  charm / warmth / quirk / minor mishap        (intensity 0.0–0.4)
~25%  mild interpersonal friction or small disappointment   (0.3–0.6)
 ~5%  real moment — fight, departure, illness        (0.6–1.0)
```

The 5% is precious. It's not avoided; it's *earned*. When real drama hits, the audience leans in because the rest of the texture has been warm.

### Charm grammar — specific examples

What "warmth" looks like in our content:

| Moodlet (good shape) | Why it works |
|---|---|
| `discovered_morning_quiet` (+3, 12h) "She liked how the apartment sounded before anyone was up." | Mundane, observed, specific. |
| `gave_unsolicited_compliment:by_<x>` (+5, 8h) "Carlos said her sketches were getting bolder." | Names the giver, pins the praise. |
| `weather_argument_with:<x>` (-2, 4h) "Bo insists it's not cold. It's cold." | Bickering, not conflict. |
| `claimed_a_corner` (+4, sticky) "The window seat by the kettle is now hers, by tacit agreement." | Tiny territorial joy. |

Anti-patterns to avoid:

| Don't write | Why |
|---|---|
| `feels_meaningless` | Audience-incompatible. |
| `lonely_3` (severity tier) | Numeric grimness. |
| `existential_dread` | Wrong tone. |
| `betrayed_by:<x>` | Strong; only allowed in the 5% drama tier and only with prior buildup. |

### Recap voice

Target voice: small-press literary fiction, slightly dry. *Not* a chronicle. *Not* a dungeon log.

Good:

> *Marisol baked too much bread again, which she does when she's nervous, and Carlos pretended not to notice it was the third loaf this week.*

Bad:

> *DAY 5 SUMMARY: Marisol (mood: anxious) prepared bread (×3). Carlos witnessed. Relationship change: +2.*

The system prompt for recap generation must enforce: past tense, named characters, specific verbs, no stat references, no list formatting unless mid-sentence.

---

## 4. The world (Day 1 baseline)

### Building shape

A **2×2 apartment grid + hallway + communal kitchen-living strip**, vertically sliced like a Tomodachi or *Habitica* dollhouse. 4 apartments unlock progressively (1A → 1B → 2A → 2B over Days 1–14). Each apartment is identical at start; furniture is the customization layer.

### Day-1 object inventory (free, present at start)

```
Per-apartment:  bed, table, chair, window, door
Communal:       hallway, communal kettle, fridge, sofa, big window
```

### Day-1 shop inventory

```
🍞 Cookbook            ¤ 2  — unlocks "cook for X" affordance
🪴 Houseplant          ¤ 1  — unlocks "tend plant" affordance + plant-comments
📔 Journal             ¤ 1  — unlocks "journal entry" cards (recap fodder)
🎵 Vinyl player        ¤ 3  — communal music; unlocks "music argument" + "shared listen" cards
🕯 Candle              ¤ 1  — atmosphere; unlocks evening cards
☕ Kettle accessories  ¤ 1  — unlocks tea-ritual cards
```

Each shop unlock = new card eligibility, not just new sprites.

---

## 5. Day 1 — first occupant

*Onboarding minutes 0–26 already specified in the [Tomodachi FTUE addendum](../research/tomodachi-life.md#walked-through-first-30-minutes). This walkthrough picks up from where that ends.*

### What the player sees

Player has spawned **Marisol Vega** (beekeeper, retired, quiet) into 1A and **Carlos Reyes** (ex-startup-founder, restless) into 1B over the first 25 minutes. They've witnessed one introduce-in-hallway scene. They click "skip to morning" and a 3-second sun-rises animation plays.

### What the storyteller did

**Session 1 (sim-day 1)** opened when Marisol moved in. It closed at the skip.

- **Director's intensity history**: 0.10 (idle empty world) → 0.32 (Marisol arrives, novelty pressure) → 0.18 (settled) → 0.41 (Carlos arrives) → 0.55 (introduction in hallway) → 0.30 (settled).
- **Cards fired** (each from `phase: opening` or `phase: ambient`):
  - `arrival.first-resident` (opening, weight 99 on empty-world trigger) — emitted Marisol's *new place. quieter than I thought.* line; bound role `arrival = Marisol`.
  - `arrival.second-resident-window-overhear` (ambient) — Marisol perceives Carlos through her window; emits moodlet `noticed_neighbor:carlos` (+1, 6h, "heard them through the wall").
  - `intro.player-bound` — fires only when player invokes Introduce verb. Stages a 5-line LLM conversation with branching options. Outcome: Marisol & Carlos → relationship `acquaintance`; both gain `met:by_<other>` moodlets (+3, 24h).
- **No closing card fired** — Day 1 closes are deliberately quiet.

### The recap (auto-generated)

> **Day 1 — *"Two strangers above an empty hallway"***
>
> *Marisol moved into 1A in the morning, set her journal on the table, and sat at the window for a long time. By dusk a second resident had arrived in 1B — Carlos, who flopped on the bed without unpacking. They met that evening in the hall when Marisol carried out her trash. The conversation was short and slightly formal. Marisol noted, later, that he seemed tired in a way she recognized.*

### What's now in the world

- 2 characters, both at relationship `acquaintance`.
- 4 active moodlets total, all positive or neutral.
- 3¤ allowance accrued; cookbook and journal already affordable.
- Player's home screen now has a recap card at top.

### What the player feels

A small, specific story they remember the next morning. They're curious whether Carlos unpacks tomorrow.

---

## 6. Day 2 — routine forms

### Open

Player opens app at sim-day-2 morning. Recap from Day 1 still pinned. Below it, a **"This morning"** card showing the world is mid-session-2.

### Mid-session beats

- **`ambient.morning-kettle`** fires at sim-hour 8. Bound roles: `early_riser = Marisol` (Marisol has stuck moodlet `discovered_morning_quiet`). She uses the communal kettle. Carlos is asleep; perception-witnessed-by is empty.
  - Emits: `had_quiet_morning` (+3, 8h) on Marisol.
- **Player intervention** — player opens the shop, buys the **Journal** for 1¤. Drags it onto the table in 1A.
  - Marisol's next turn: an LLM call with the new affordance in scope. She uses it. Card-runtime emits: `wrote_journal_entry` (+2, 12h) on Marisol. The journal text becomes a perception event readable in the inspector.
- **Request to player**: Carlos wakes up around sim-hour 11. Card `request.first-meal` triggers (he has no cookbook yet, no food).
  - **Carlos asks:** *"Can I order something? I haven't eaten."* [Approve / Decline / ignore]
  - Approve → delivery happens, +2 hunger satisfied (need axis).
  - Decline → emits `slightly_resented:by_player` (-2, 6h) on Carlos. *(This moodlet is allowed because the player is a first-class entity in the world.)*
- **`ambient.balcony-overhear`** fires when both characters are within hallway distance — bound `eavesdropper = Marisol`, `subject = Carlos`. Marisol overhears Carlos on the phone with someone (LLM scene). She gains `glimpsed_neighbors_life:carlos` (+2, 24h).

### Close

Sim-day-2 closes at user's 5 AM (or skip). 

### The recap

> **Day 2 — *"The journal Marisol bought herself"***
>
> *Marisol started a journal — she keeps small things in it, mostly weather and the names of the plants that aren't there yet. Carlos slept past noon and ordered food when he finally woke. In the afternoon, Marisol overheard him on the phone, half a sentence about a meeting that didn't happen. She didn't ask, and he didn't bring it up.*

### What's now in the world

- Marisol has 3 sticky-or-long moodlets that are starting to feel like personality (morning quiet, claimed-window-seat, journal habit).
- Relationship still `acquaintance` but warmer (the eavesdrop counts as soft tissue).
- Player has spent 1¤; 5¤ available.

---

## 7. Day 3 — preferences emerge

### What this day is for

Day 3 is the first day where **specific quirk** (the audience hook) becomes visible. Each character starts revealing idiosyncratic preferences. These are emitted as `preference_revealed` perception events and *appended to `about`* in a `preferences:` block.

### Beats

- **`preference.reveal-trigger`** is a special card type that fires once per character per few sim-days when they have low recent novelty.
  - Marisol: revealed via dialogue with Carlos at the kettle. *"I can't drink anything black after 11."* Stored: `about.preferences += "no caffeine after 11"`.
  - Carlos: revealed via journal-via-window scene. Marisol notices he writes left-handed but eats right-handed. Stored: `about.preferences += "left-handed (writing only)"`.
- **`ambient.weather-bicker`** — Marisol thinks the kitchen is cold; Carlos thinks it's fine.
  - Both gain `weather_argument_with:<other>` (-2, 4h, "kitchen-cold disagreement"). The negative is the joke, not real conflict.
- Player buys the **Cookbook** for 2¤. Places it. New affordance unlocks `cook_for(target)`.
- Marisol's next turn: she cooks. Bread, because the LLM noticed she has a `bakery → beekeeping` arc in her `about`. The card-runtime spawns the `cooked_for` event.

### Recap

> **Day 3 — *"Things they will eventually argue about"***
>
> *Marisol revealed she stops drinking coffee at 11; Carlos pretended this was unhinged. They argued about whether the kitchen is cold (it is). She baked anyway, and left two slices of bread on the counter. He ate one without commenting. The unspoken second slice has, by morning, become a small ritual.*

### What's now in the world

- Each character has 1–2 lines under `about.preferences`. The LLM now uses these in every prompt.
- Relationship is still `acquaintance`, but Marisol→Carlos has a `+8` reservoir from accumulated `:by_carlos` moodlets. One more event will tip it.

---

## 8. Day 4 — relationship transition

### Beats

- **`transition.acquaintance-to-friend`** is a structural card — fires when the relationship reservoir crosses +12. It's not random; it's earned.
  - Stages a small two-character LLM conversation in the communal kitchen.
  - Outcome: relationship state machine transitions `acquaintance → friend`.
  - Notification to player: *"Marisol and Carlos are now Friends."* (Tomodachi-style; no sound, no fanfare, just a small sentence at the bottom of the screen.)
  - Unlocks: `request.deeper-conversation` is now eligible for either character.
- A **third apartment slot unlocks** at sim-day 4 (per the FTUE walkthrough). Soft notification: *"A character has asked to move in."* Player can welcome (system-seeded), pass, or hand-author.
- Player welcomes **Tomek** (a poker player, awkwardly social).

### Recap

> **Day 4 — *"Friends, by accident"***
>
> *Sometime around the second cup of tea, the word "neighbor" fell off and they were just two people who happened to live across a hallway. Neither of them said anything about it. In the afternoon a third resident arrived — Tomek, who knocked twice, apologized for knocking twice, and then apologized for apologizing.*

### Notes on the system

This is the day the audience-tuning shines: the relationship transition is a *small typed event*, not a celebratory unlock screen. The recap names it with a single sentence. The player feels it because they've been watching, not because the game told them.

---

## 9. Day 5 — first arc card kicks in

### What this is

Days 1–4 were established by single-card events. Day 5 introduces the **multi-card arc**: a story that spans 2–3 sim-days.

### The arc: *"Tomek's tournament"*

- **Card `arc.tomek-tournament.day-1`** fires Day 5 morning (intensity drops because Tomek is a fresh character; the director is happy to spend on him). Tomek mentions he's been invited to a small poker tournament across town. Asks Marisol's opinion.
  - LLM scene plays. Marisol gives a careful answer. Both gain low-key moodlets (`asked_for_advice:by_tomek` on Marisol; `confided_to:marisol` on Tomek).
  - `SetData("tomek_tournament_state", "considering")`.
- Mid-Day 5: ambient bicker between Carlos and Tomek about whether poker is "real money or fake stress." Mild friction, ~`-2` moodlets, not a fight.
- End Day 5: `arc.tomek-tournament.day-2` is *queued* via `TriggerCard` with delay 1d.

### Recap

> **Day 5 — *"Tomek, who is thinking about something"***
>
> *Tomek told Marisol about the tournament over the kettle, in the casual tone people use for things they're nervous about. Carlos overheard part of it and made a face he tried to take back. Marisol, in her journal that night, wrote one line: "He'll go." She doesn't usually predict things in writing.*

---

## 10. Day 6 — arc midpoint + first trait promotion

### Beats

- **`arc.tomek-tournament.day-2`** fires morning sim-day-6. Tomek has decided. Brief scene with all three; he packs.
- **Trait promotion check** runs (storyteller §6 promotion rules). Marisol has accumulated:
  - 6× `discovered_morning_quiet` over Days 1–6, all sticky.
  - The pattern matches a promotion rule.
  - Promoted: `about.traits += "Loves the apartment before anyone is up"`.
  - Perception event emitted; both other characters witness it as a small noted change.
- Player buys the **Vinyl Player** for 3¤ and places it in the communal living strip. New cards unlock:
  - `ambient.late-night-music` (eligible only when 2+ chars in proximity in evening hours)
  - `argument.music-volume` (low-stakes friction card)

### Recap

> **Day 6 — *"Things being put down and picked up"***
>
> *Tomek packed. Carlos handed him a coat he wouldn't admit was his. Marisol, who has now spent six mornings in a row alone with the kettle and the not-yet-arrived plants, has earned the corner. She isn't fighting anyone for it; it's just hers. After Tomek left, the apartment was quieter than the quiet she usually likes.*

### Notes

The trait promotion is the audience-critical moment: it's the first time a *character has changed*. The system recognized something the player had already felt. This is the compounding-investment payoff in miniature.

---

## 11. Day 7 — established rhythm

### What's now true

By Day 7 the player has:

- **3 characters** (Marisol, Carlos, Tomek) — Tomek is currently away mid-arc.
- **6 moodlets active** across the household, ~5 positive / 1 mild-negative.
- **2 promoted traits** (Marisol's morning corner; Carlos's "apologizes for apologizing" — promoted on Day 5 via repeated `apologized_unnecessarily` moodlets).
- **3 idiosyncratic preferences** in the `about.preferences` blocks.
- **Relationship state**: Marisol & Carlos = friend; Marisol & Tomek = friend; Carlos & Tomek = acquaintance (mildly bickery).
- **Object inventory**: cookbook, journal, vinyl player.
- **Currency**: 3¤ (just enough for a houseplant).

### Beats

- **`arc.tomek-tournament.day-3`** fires — return arc. Tomek comes back, possibly with news. The card has *two* outcomes seeded:
  - 60% — he placed in the tournament, returns slightly more confident; emits `won_something_small` + a unique acquired moodlet `pride_in_him:by_player` on player-side.
  - 40% — he didn't place; returns sheepish, emits `weathered_a_loss` (sticky negative −3 on Tomek for 3 days, but fades into a quiet trait by Day 10).
- Whichever fires, the day's recap leads with it. Marisol journals about it.
- **`request.routine-question`** — Carlos asks the player: *"Mind if I move my desk into the living strip? I work better with someone in earshot."* This is a customization request that, if approved, mutates the apartment layout in a tiny but visible way. Player decision is recorded; refusal isn't punished.

### Recap

> **Day 7 — *"He came back"***
>
> *Tomek came back tired and a hundred dollars richer, which he announced like an apology. Marisol made him sit down. Carlos asked how the tournament was, in a voice that was not quite teasing. Tomek answered carefully. By evening, the vinyl player had been on three times — once for each of them, and once together — which is the most it has been used since it arrived.*

### What this slice has just demonstrated

In seven sim-days:

- **Three characters, three textures.** Marisol = quiet observer; Carlos = restless ironist; Tomek = trying. The audience knows each of them.
- **One full multi-day arc resolved.**
- **Two trait promotions.** The world is no longer reset-able to Day 1.
- **A relationship transition.**
- **Two player customization moments** (object placement, layout shift) that left fingerprints.
- **Five recaps the player can re-read.** Each one stands alone; together they're a small novel.

---

## 12. Content seed — 15 starter cards

The minimum to stand up the experience. Files in `cards/`. Phase tag in frontmatter.

```
opening/                          (fire near session_open)
  arrival.first-resident.md
  arrival.new-resident-welcome.md
  ambient.morning-kettle.md
  ambient.weather-bicker.md
  preference.reveal-trigger.md

ambient/                          (fire mid-session)
  intro.player-bound.md           (player-triggered Introduce verb)
  request.first-meal.md
  request.deeper-conversation.md
  ambient.balcony-overhear.md
  ambient.kitchen-shared.md
  ambient.late-night-music.md
  argument.music-volume.md
  transition.acquaintance-to-friend.md

closing/                          (fire near session_close)
  closing.journal-entry.md
  closing.window-watching.md
```

Plus 1 multi-card **arc** as a seed: `arc.visiting-traveler.{day-1, day-2, day-3}.md` — a stranger arrives, integrates, leaves with a small token. Same shape as the tomek-tournament arc above.

---

## 13. Sample recaps (Day-1 vs Day-7 contrast)

The most concrete spec for *what we're shipping* is what the recap reads like at Day 1 vs. Day 7. The grammar should *deepen* without changing voice.

| | Day 1 | Day 7 |
|---|---|---|
| Length | 2 sentences | 4 sentences |
| Named characters | 1–2 | 2–3 |
| References to history | 0 | 1–3 |
| Relative-time phrases | none | "again", "still", "as he tends to" |
| Voice | introductory | familiar |

Day 1: *"Marisol moved into 1A in the morning…"*
Day 7: *"Tomek came back tired and a hundred dollars richer, which he announced like an apology. Marisol made him sit down."*

The single-recap test for whether we've shipped the thing: **does Day 7's recap reference something the user remembers from earlier in the week?** If yes — the system has compounded. If no — we shipped a screensaver.

---

## 14. UI moments per day

What surfaces in the app when the user opens it on each day:

| Day | Home screen | Inspector | Notifications |
|---|---|---|---|
| 1 | Empty → onboarding → recap pinned | hidden | 1: "Marisol & Carlos met" |
| 2 | Day 1 recap + "this morning" card | reachable from map | 1 request (Carlos's meal) |
| 3 | Day 2 recap on top, Day 1 below | preferences tab populates | 1: weather bicker |
| 4 | recap stack growing | new "Friends" tag on relationship | 2: friend transition; new resident |
| 5 | recap + "an arc started" subtitle on today's card | active arcs visible | 0–1 |
| 6 | recap; Marisol's avatar gets a small icon for promoted trait | "traits" tab populates | 1: trait promotion |
| 7 | recap + Tomek-returned moment featured; week-summary "this week" CTA appears | full memorial / week views | 0–1 |

The week-summary CTA at Day 7 is a single auto-generated paragraph summarizing the week, optionally shareable. This is the *re-engagement hook for week 2* — the player opens it, reads it, sees something they want to follow up on.

---

## 15. What this slice tests + acceptance criteria

### Hypothesis

> A user who plays The Sims, Animal Crossing, or Tomodachi Life will return for at least 5 of 7 consecutive days when given this experience.

### Acceptance criteria

The vertical slice is shipped when, with no human curation between sessions:

1. **Day 1**: a fresh user, given a blank world, can have 2 characters living and a recap by minute 30.
2. **Days 2–6**: at least one *named, specific* moment per day appears in the recap. (No generic "ambient activities took place.")
3. **Day 4 or 5**: at least one relationship transition has fired and is visible to the user.
4. **Day 6 or 7**: at least one trait promotion has fired and is visible in `about`.
5. **Day 7**: the recap stack reads as a coherent week — names recur, callbacks happen, voice is consistent.
6. **No grim drift**: no character is in `lousy` mood band for >2 consecutive sim-days unless the player is driving a deliberate arc.
7. **No slop voice**: zero recap sentences with em-dashes, "I'm sorry", or list formatting. (Manually graded; failure → recap prompt iteration.)

### What this slice **does not** include

- Schedules per character (#235 slice 3) — daily activity timetable is implicit in card phases for now.
- Inter-building / outdoor scenes — apartment + hallway + communal only.
- Voice/TTS — text only.
- Multi-user / public-relay aspects — single-user, local workspace.
- Combat, illness mechanics, weather as a system — flavored via cards only.
- Festivals / holidays — out of scope for the 7-day slice; they're a Day 14+ feature.

---

## 16. Traceability — what this maps to in the codebase

| Vertical-slice element | Implementation home | Status |
|---|---|---|
| Moodlet emission + sum + prompt block | `agent-sandbox/pi-bridge/moodlets.js` (NEW) | Slice 1 of [storyteller.md](storyteller.md) |
| Sim-day rollover + recap LLM call | `agent-sandbox/pi-bridge/storyteller/session.js` (NEW) | Slice 2 |
| Card loader from `cards/*.md` + action DSL | `agent-sandbox/pi-bridge/storyteller/cards.js` (NEW) | Slice 3 |
| Director + intensity scalar | `agent-sandbox/pi-bridge/storyteller/director.js` (NEW) | Slice 3 |
| Trait promotion at session_close | `agent-sandbox/pi-bridge/storyteller/promotion.js` (NEW) | Slice 4 |
| Relationship state machine (`acquaintance/friend/…`) | extend existing relationship store; #255 substrate | Slice 4 |
| Currency + shop + object unlock routing | extend `objects.js` + new UI surface | Slice 5 (UI-side) |
| Recap rendering, recap stack, week-summary CTA | `src/Sandbox.jsx` + new `Recap.jsx` | Slice 2 (basic); 6 (polish) |
| Player Approve/Decline request UI | `src/RequestQueue.jsx` (NEW) | Slice 3 |

---

## 17. Summary

- The audience is the **narrative-sandbox cohort**. They want warmth, specificity, low stakes, and a daily rhythm.
- Three loops: **session (daily)**, **weekly (arcs and transitions)**, **long (months — irreplaceable history)**.
- Tonal calibration: **70/25/5** charm-to-friction-to-drama.
- Days 1–7 walked above produce: 3 characters with personality, 1 multi-day arc resolved, 2 trait promotions, 1 relationship transition, 5 recaps that read as a week of small fiction.
- **Acceptance test**: would a Sims/AC/Tomodachi player return on Days 2–7? If yes, the slice is right.
- 15-card content seed + 1 arc is the floor. Every additional card is additive.
- This slice depends on storyteller slices 1–3 (moodlets, sim-day + recap, card pool v0). Slices 4–6 deepen the experience but the loop is real at slice 3.

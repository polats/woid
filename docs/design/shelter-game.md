# Shelter — Game Design Doc

Working doc for Shelter's progression and game systems. Iterative — sections marked _[TBD]_ get filled as we decide. Today's iteration: enumerate the reference games' systems so we have a vocabulary to design against.

References: Fallout Shelter (Bethesda, 2015), The Elder Scrolls: Castles (Bethesda, 2024). Cited with footnote links.

---

## 0. What we have now (one-liners)

Already running in Shelter as of 2026-05-07. Detailed pointers live in the codebase.

| System                              | Status   | Where                                         |
|-------------------------------------|----------|-----------------------------------------------|
| 4-slot daily schedule resolver      | shipped  | `src/lib/shelterStore/resolver.js`            |
| Multi-room building, vertical grid  | shipped  | `src/lib/shelterWorld/`, `views/Shelter*.jsx` |
| Pacing move/rest cycle (idle/wave)  | shipped  | `resolver.js` + `ShelterStage3D.jsx`          |
| Kimodo-driven avatar animation      | shipped  | `src/lib/kimodo/`, `animationLibrary.js`      |
| Animation tag registry + role swap  | shipped  | `animationLibrary.js`                         |
| Tap-to-focus character (cel outline, face camera, wave) | shipped | `views/ShelterStage3D.jsx`        |
| Profile card (avatar/name/bio + schedule tab)           | shipped | `views/ShelterCharacterCard.jsx` |
| Sim clock, save state in localStorage                   | shipped | `shelterStore/`                  |
| Bridge-side characters (name, pubkey, bio, persona)     | shipped | external (`pi-bridge`)           |

Planned-not-yet-built that's adjacent to game design (from `tasks/`):
- **#285 multi-room building** (in progress) — apartments + hallways + cross-room walks.
- **#295 narrative state** (todo) — threads / arcs / loops / ambitions / quests as event-sourced state.
- **#325 shop, currency, unlocks** (todo) — per-workspace ¤ currency, Day-1 inventory, object-placement room unlocks.
- **#335 traits system** (todo) — constitutional + promoted traits, modulate needs/moodlets/prompt.
- **#315 trait promotion + memorial** (todo) — long-running moodlet patterns become durable traits; departed characters persist.
- **#345 sleep silence scheduler** (todo) — per-character `asleep_until` instead of "advance 8h" hack.
- **#395 schedule editor UI** (todo) — make the Schedule tab editable.
- **#455 sound library** (todo).
- **#465 spell injections** (todo) — user-triggered world perturbations.

**Conspicuously absent today:** currency, XP, unlocks, combat, crafting, inventory, lineage/breeding, aging, succession, quests, threats, decoration. Game is currently a calm life-sim; no progression spine yet.

---

## 1. Fallout Shelter — system enumeration

| # | System                         | Mechanic summary                                                                 | Progression hook |
|---|--------------------------------|----------------------------------------------------------------------------------|------------------|
| 1 | Dwellers                       | Recruited via vault door, radio room, lunchboxes, breeding, quest rewards. Editable name + portrait + SPECIAL stats. | Roster size + named legendaries |
| 2 | SPECIAL stats                  | Strength / Perception / Endurance / Charisma / Intelligence / Agility / Luck — 7 dials, base 1–10, +7 from outfits. Each room is bound to one stat. | One training room per stat raises base; level cap 50 |
| 3 | Room construction              | Three-wide rooms on a vertical grid. Identical adjacent rooms **merge** (up to 3 wide). Each room has 3 upgrade tiers. | Unlocks gated by dweller count; tiers cost caps |
| 4 | Resources                      | **Power / Food / Water** live bars + **Caps** (soft currency) + **Stimpaks / RadAway** (consumables). | Bigger vault → bigger bars |
| 5 | Happiness                      | 0–100% per dweller and aggregate. Job-fit (matching SPECIAL), gifts, pregnancy, radio raise it; deaths, hunger, rads, fires lower it. Multiplies all production. | Aggregate hits 100% → bonus caps |
| 6 | Combat / threats               | **Incidents**: radroaches, mole rats, fires, raiders, ghouls, deathclaws. Auto-attack with weapon + Endurance + dweller HP. | Better weapons + Endurance + vault door tiers |
| 7 | Crafting                       | Three workshops — **Weapon / Outfit / Theme** — consume **junk** for tiered items (common → legendary). | Workshop tier 3 unlocks legendary recipes |
| 8 | Family / lineage               | Adult opposite-sex non-relatives in living quarters → flirt → pregnancy (~3h) → birth. Children inherit randomized SPECIAL near parents'. **No aging, no death-of-old-age.** | Cheap population route; Charisma speeds flirting |
| 9 | Quests                         | Two layers: solo wasteland scavenging (real-time), and Overseer's Office quests (3-dweller party, scripted dungeons, weekly quests). | Overseer tiers gate quest difficulty + rewards |
| 10 | Time                          | Real-time always-on; no offline acceleration except **Mr. Handy** robots auto-collecting one floor's resources. | Mr. Handys per floor |
| 11 | Storage                       | Shared **Storage Rooms** for weapons/outfits/junk/pets, capped by storage tier. | Build/upgrade |
| 12 | Random events                 | Mysterious Stranger (cap drop), mole-rat ambushes, Deathclaw raids, Bottle & Cappy. | Active-play incentive |
| 13 | Population cap                | 10 starter + 4 per Living Quarters; absolute cap **200**. | Build more LQ |
| 14 | Premium economy               | **Nuka-Cola Quantum** (premium) + **Lunchboxes / Mr. Handy boxes / Pet carriers** (4-card random rewards: caps, resources, outfits, weapons, dwellers, pets). | Daily objectives drop lunchboxes |
| 15 | Decoration                    | **Theme Workshop** crafts per-room skins (Vault-Tec, Wasteland, etc.). | Cosmetic only |
| 16 | Multiplayer                   | n/a                                                                                | — |

[^fs-wiki][^fs-special][^fs-rooms][^fs-chars][^fs-pets]

---

## 2. The Elder Scrolls: Castles — system enumeration

| # | System                  | Mechanic summary                                                                  | Progression hook |
|---|-------------------------|-----------------------------------------------------------------------------------|------------------|
| 1 | Subjects                | Recruited via Castle Gate, marriage births, quests, recruitment. Each has **race** (9 ES races), **rarity** (Common → Legendary), and **traits**. | Recruit/breed for rarity + trait stacks |
| 2 | Stats / traits          | No SPECIAL — subjects have **proficiencies** for stations and **trait modifiers** ("Mighty," "Pyromaniac," "Bossy"). 1–2 traits common → up to 7 legendary. | Curate trait pool via breeding + banishment |
| 3 | Room construction       | Vertical castle grid like Shelter; production stations: Smithy, Kitchen, Loom, Oil Press, Mill, Mine. Plus Throne Room, Shrine of Mara (marriage), Heir Hall. Mergeable + tier-upgradable. | Unlocks gated by **Dynasty Level** |
| 4 | Resources               | **Food / Wood / Ore (stone) / Oil / Gold**. Production rooms feed crafting, not direct consumption. | Upgrade stations for throughput |
| 5 | Happiness               | Per-subject and per-race. Bad rulings or unlucky seating drop it. **Zero-happiness subjects can attempt to assassinate the Ruler.** | Feeds rulings + intrigue |
| 6 | Combat                  | External: dispatch up to **3 Adventurers** vs 1–3 enemy waves. Auto-battler with skills, healing potions, resurrection scrolls. Internal: assassination attempts. | Better gear + leveled Adventurers |
| 7 | Crafting                | Smithy crafts weapons/armor at tiers gated by ore/wood/oil + station level. Potions and scrolls consumable. | Drives Adventurer combat synergy |
| 8 | **Marriage / lineage / dynasty** | Subjects married at **Shrine of Mara** (race/trait/status compatibility). Married couples produce **up to one child per real day**. Children inherit traits probabilistically. Marrying a noble elevates a commoner. | The meta-progression spine |
| 9 | **Ruler + heir + succession** | The **Ruler** must name an **Heir**. On Ruler's death (old age or assassination) succession picks from eligible nobles, ending one **reign** and starting another. | Each reign is a chapter |
| 10 | **Time / aging**       | **1 real day = 1 in-game year.** Subjects age continuously; **death of old age ~64**. Time passes offline (subjects age, resources accrue, babies born). | Forces succession planning |
| 11 | Quests                 | Episodic story quests + repeatable battle quests + **Sheogorath's Gauntlet** (endless/roguelike combat tower). | Gold, resources, gear, XP |
| 12 | Storage                | Equipment/resource caps tied to room tiers (less granular than Shelter). | Upgrade |
| 13 | **Rulings system**     | Pop-up dilemmas presented to the Ruler (subject disputes, requests, moral choices) with 2–3 branching options. Outcomes: happiness per race/faction, gold, intrigue, trait drift. Can be deferred. | The marquee narrative system |
| 14 | Population cap         | Raised by housing rooms (sleeping quarters / heir halls). Lower headline cap than Shelter. | Build more |
| 15 | Premium economy        | **Crowns** (premium currency) + **Chests** (gacha). Drop subjects, gear, resources. | Daily/objective driven |
| 16 | Decoration             | Room themes, **monuments**, banners; ruler statues commemorate past dynasty members. | Monuments unlock through dynasty milestones |
| 17 | **Race relations**     | Inter-race like/dislike modifies room placement, marriage eligibility, ruling outcomes. | Permanent texture on every choice |
| 18 | **Banishment**         | Permanent removal of subjects to manage trait/lineage hygiene. | Eugenics knob |
| 19 | Multiplayer            | n/a                                                                                | — |

[^esc-uesp][^esc-rulings][^esc-resources][^esc-quests][^esc-traits][^esc-marriage][^esc-bs][^pl-compare]

---

## 3. What Castles adds over Shelter

The shared skeleton (vertical grid, room-merge, production bars, room-stat assignment, lunchbox/chest gacha, real-time idle, auto-combat quests) is consistent. Castles' net-new design ideas:

1. **Compressed time + aging** — 1 day = 1 year; offline aging.
2. **Death of old age + succession** — Ruler/subject expiry ~64; Heir naming required.
3. **Dynasty meta-progression** — Dynasty Level gates room/feature unlocks across reigns; account-level identity is the **house**, not a single overseer.
4. **Marriage as gameplay** — Shrine of Mara compatibility checks; commoner→noble promotion.
5. **Heritable traits** — Children inherit probabilistically; breeding becomes eugenics with a target trait pool. Shelter has only randomized SPECIAL noise.
6. **Rulings system** — Branching narrative dilemmas with multi-axis consequences. Shelter has no decision system.
7. **Intrigue / assassination** — Unhappy subjects can murder the Ruler, forcing succession. Shelter discontent only lowers production.
8. **Race relations** — Inter-race like/dislike modifies placement, marriage, rulings.
9. **Banishment / exile** — Permanent removal for trait hygiene.
10. **Trait-rarity character economy** — Common→Legendary subjects with 1–7 traits replace flat SPECIAL roll.

What Castles *drops*: explicit SPECIAL dials, the radio-broadcasting recruit loop, themed in-vault incidents (radroach/fire/mole rat tied to rushed rooms), and the dual workshop split (weapons/outfits/themes).

---

## 4. Design pillars

Shelter is **inspired by Severance** for tone and structure, **Elder Scrolls: Castles** for the progression mechanic, and powered by our **story director** (#275) for the moment-to-moment narrative.

### 4.1 Severance-style shifts (replaces always-on residency)

Characters **come in for a shift and leave**. Each character has a per-day shift schedule of `(arrival_time, departure_time, room_assignment)`. Different characters arrive and leave at different times — staggering creates natural pacing.

| State            | What it means                                                                  |
|------------------|--------------------------------------------------------------------------------|
| `off_shift`      | Outside the facility. Not rendered. Story director may still log "outie" beats. |
| `arriving`       | Enters via the entrance / elevator at the start of their shift.                |
| `on_shift`       | Inside the facility. Drives current schedule resolver / pacing / role swap.    |
| `departing`      | Leaves via the same exit at end of shift.                                      |

**Replaces** the current always-resident model (every agent always has `pos` in some room). The schedule resolver becomes the *on-shift* sub-state machine; arrival/departure are new top-level states. Leaving the facility frees the room and clears walking/pacing fields the same way a state transition does today.

**Open detail:** does the player see who's *about to* arrive (a quiet "next on shift" indicator), or do they just appear? Severance does the latter; Castles does the former with notification badges. Lean Severance — surprise reads better with the mystery framing.

### 4.2 Castles-style XP → tier → room unlocks (the progression spine)

Tiers replace Castles' "Dynasty Level". A tier is a **layer of the facility** — Level 1 is the surface departments, deeper levels are progressively stranger.

- **XP source:** completed shifts. Each shift completion = `XP_PER_SHIFT × shift_quality`. Quality can fold in things we already have (need satisfaction, mood, trait synergy with the room) so the existing systems feed progression rather than getting bypassed.
- **Tier-up:** total XP across all characters → Facility Level. Each level grants:
  1. A small set of new room types unlocked for placement.
  2. A **narrative beat** authored by the story director — the level's mystery layer reveals.
  3. Sometimes new shift slots ("the night shift opens at Level 4") that change the staggering pattern.
- **Tiers are sticky:** unlocked rooms stay unlocked even if the roster changes. Tier-ups are the long-arc identity of the save file (the equivalent of Castles' reigns / dynasty milestones).

### 4.3 Narrative driven by story director (#275)

The story director — currently designed for Sims-mode session storyteller — extends to Shelter as the **mystery generator**. It owns:

- **Per-tier reveals** — when the player hits Tier N, the director picks (or generates) a beat appropriate to that depth (e.g. Tier 2 unlocks the *Optics & Design analogue*; the beat introduces the room's ambient weirdness).
- **Per-character arcs** — using #295 narrative state's threads/arcs/loops/ambitions: each character has an evolving relationship to the facility's mystery. Some characters glimpse more, some less. Story director plants threads that pay off across multiple shifts.
- **Daily emergent text** — what the character's "innie" is thinking on shift, what their "outie" is doing off-shift (lightly hinted, not fully simulated). Roughly the role of #275 + image-post recap, but tuned to the closed-world Severance vibe rather than open-world Sims gossip.

The director's prompt context includes: facility tier, current shift roster, recently-revealed mystery beats, character traits + threads. Output: short narrative blurbs surfaced in a "Stories" pane and on the character profile card.

### 4.4 Inheritance from Castles vs. Fallout Shelter

| System (from §1/§2)            | Adopted? | Notes                                                                                |
|--------------------------------|----------|--------------------------------------------------------------------------------------|
| Vertical grid + room-merge     | ✓        | Already shipped (#285).                                                              |
| Dynasty Level → unlocks        | ✓ (renamed Tier) | Core spine.                                                                  |
| Time compression / aging       | **✗**    | Severance is real-time-shift, not generational. We stay real-time.                   |
| Death of old age + succession  | ✗        | No aging.                                                                            |
| Marriage / lineage             | ✗        | Our agents are pubkey-keyed nostr identities, not procedural offspring.              |
| Rulings system                 | **partial** | We don't ship Castles' branching dilemmas, but the story director's per-tier beats are the analogue. Could later add Severance-flavored "Compliance Handbook" rulings. |
| Race relations                 | ✗        | Replaced by departments / trait synergies (#335).                                    |
| Banishment                     | maybe    | "Voluntary departure" as a story-director-driven exit hook is on-tone.               |
| Combat / threats               | **✗** (initially) | Severance has no combat. Could later add "MDR refinement defects," "intruder drills" but not for v1. |
| Crafting                       | ✗        | No analog in the source material.                                                    |
| Premium currency / gacha       | **deferred** | Possible later, but a Severance-themed gacha feels mistuned.                  |
| Decoration / themes            | yes      | Decorations are part of the mystery aesthetic — "the ranks have appeared on the wall."|
| SPECIAL stats                  | ✗        | Replaced by traits (#335) — narrative-feel modifiers, not seven dials.               |
| Quests / wasteland exploration | ✗        | Mystery beats replace explicit quests. The "deeper rooms" are the exploration.       |

---

## 5. Progression spine

### 5.1 XP formula (sketch)

```
shift_xp = XP_PER_SHIFT
         × need_satisfaction_factor      // existing energy / social
         × room_trait_synergy_factor     // when we ship #335
         × novelty_bonus                 // first time character works in a room
total_xp += shift_xp
```

`XP_PER_SHIFT` calibrated so a casual player hits Tier 2 around end-of-day-1, Tier 3 around end-of-week-1. Multipliers stay in [0.5, 2.0] so the floor isn't punishing and the ceiling isn't grindy.

### 5.2 Tier table (initial sketch — to be re-tuned)

| Tier | Theme                       | Rooms unlocked (examples)                | Mystery beat (story-director seed)                                |
|------|-----------------------------|------------------------------------------|--------------------------------------------------------------------|
| 1    | Reception / orientation     | Lobby, break room, basic work-floor      | "First day. The handbook is on every desk."                        |
| 2    | Departments                 | MDR analogue, O&D analogue, recovery     | "A new department appears on the elevator panel."                  |
| 3    | Wellness                    | Wellness room, archives, music-and-dance | "There's a wellness session today. Please bring nothing."          |
| 4    | Night shift                 | New shift slots; Testing Floor analogue  | "After-hours work begins. The lights stay on for someone."         |
| 5    | Severed floor               | Restricted-access workrooms              | "The badge clearance changed overnight."                           |
| 6+   | _[TBD]_                     | _[TBD]_                                  | Story director takes the wheel from here.                          |

Tiers 1–4 are authored as fixed seeds; from Tier 5 onward the director starts generating. This lets us hand-craft the early game and let the system stretch the long tail.

### 5.3 Room categories

- **Work rooms** — the productive surface. Agents do their job here. XP per shift is room-dependent.
- **Service rooms** — break room, wellness, hallway. No XP, but satisfy needs and modify mood.
- **Mystery rooms** — unlocked at higher tiers. Less productive, more narrative weight; the story director uses them as set pieces.

Each room has: a `tier_required`, a `category`, an optional `trait_synergy` array, and optionally a `mystery_beat_id` the director references.

---

## 6. Currency + unlocks

Keep it minimal for v1:

- **XP is primary currency.** Earned by shifts. Spent implicitly via tier-ups (no explicit "buy this room with XP" — tier-up *grants* a roster of rooms; the player picks which to place).
- **Soft currency (¤)** from #325 stays for *placing* rooms inside an unlocked tier. Tier-up grants the unlock; ¤ pays for the build.
- **No premium currency** in v1. If we ever add one it should be themed to the mystery (Lumon-style "compliance points") not a generic gacha.

Open question: do we want a "discovery" currency separate from XP — i.e. exploring the facility (clicking around, finding hidden hallways) yields a different progression resource than completing shifts? Defer to playtest.

---

## 7. Opening scenario (tutorial)

Anchor names locked:
- **Receptionist NPC: "Edi Schmid"** (permanent, lives in the Lobby).
- **Default work room: "Pattern Sorting"** (the Pattern Sorting Room, MDR analogue).
- **First service room: "Break Room"** (unlocked by the first tier-up).

### 7.1 Beat sequence

```
0. Cold open — camera on the Lobby (top floor), Edi Schmid alone.
1. Dialogue overlay: Edi welcomes the player; tells them to pick their first employee.
2. A folder opens; 3 candidate cards (resume + portrait + one-line bio) are
   drawn from the agent sandbox.
3. Player taps a card → hire commits. Agent walks in through the Lobby
   entrance into off_shift→arriving→on_shift transitions.
4. Player taps the agent → profile card opens. New "Assign Job" button.
5. Tap → camera zooms out, valid rooms glow. Pattern Sorting is the only
   built room, so it's the only target.
6. Tap Pattern Sorting → assignment commits. Camera follows agent in;
   they take a workstation. Work loop starts.
7. Shift completes. Two rewards drop in sequence:
   a. Currency icon (¤) above the agent — tap to collect, balance ticks up.
   b. XP icon — tap to collect, the player's XP bar fills, then a TIER-UP
      banner plays. Tier 2 unlocked. New room type appears in the build
      menu: Break Room.
8. Tutorial overlay: "Spend ¤ to build the Break Room." Highlights the
   adjacent build slot.
9. Player taps the slot → build menu shows Break Room (now unlocked) →
   tap to spend currency, build animation plays.
10. Camera focuses on the agent. Energy bar revealed; ticking down.
11. Tutorial overlay: "When an employee runs out of energy, they take a
    break automatically."
12. Energy hits threshold → agent walks to Break Room, energy refills, walks
    back to Pattern Sorting. Loop continues.
13. Tutorial ends.
```

### 7.2 Why XP *and* currency

The two rewards have different jobs and the tutorial introduces both at the same beat to teach the distinction:

- **¤ (currency)** — earned per shift, spent to place a room you already have access to. The "buy this thing right now" lever.
- **XP / tier** — earned per shift, accumulates toward facility-level tier-ups. Tier-ups unlock new room *types* (and gate later mystery beats per §4.3). The "what's possible" lever.

A locked room is *unlocked by tier* and *placed by currency*. The Break Room flow makes this two-step relationship visible on the very first shift completion: "You can't build something you haven't unlocked, and you can't unlock something without doing the work."

### 7.3 Systems revision (XP added)

Adding one row to the §7-systems table from the prior iteration; renumbering cleanly here as the canonical list:

| #   | System                                  | Brief                                                                               | Existing task |
|-----|-----------------------------------------|-------------------------------------------------------------------------------------|---------------|
| S1  | Receptionist NPC (Edi Schmid)           | Non-recruitable, pinned to Lobby. Drives dialogue.                                  | new           |
| S2  | Dialogue overlay                        | Line-by-line text + portrait + advance-tap. Scripted now, director-driven later.    | new           |
| S3  | Candidate picker (folder UI)            | 3 resume cards drawn from agent sandbox. Tap-to-hire.                                | new           |
| S4  | Sandbox → Shelter hire pipe             | Move an agent from the sandbox bridge into Shelter's roster. Defines "hired."       | new           |
| S5  | Arrival / departure FSM                 | `off_shift / arriving / on_shift / departing` over the existing schedule resolver.  | per §4.1      |
| S6  | Job assignment UI                       | "Assign Job" → zoom out → tap valid room → write `assignment.roomId + role`.       | new           |
| S7  | Work production loop                    | Progress accumulates over T seconds → "ready" state.                                | new           |
| S8  | Reward popup + collect                  | Icons over agent's head; tap to collect.                                            | new           |
| S9  | Currency (¤)                            | Per-workspace soft currency, persisted, spent on builds.                            | **#325**      |
| **S9b** | **XP / tier-up system**             | **XP per shift accumulates against tier thresholds. Tier-up unlocks new room types and triggers a level-up banner. Story director hooks per §4.3.** | **new**       |
| S10 | Room build / placement                  | Locked types are hidden in build menu; unlocked types show; ¤ pays to place.        | extends **#285** |
| S11 | Break Room (service room)               | Unlocked at Tier 2. Restores energy when occupied.                                  | new           |
| S12 | Energy need + UI                        | [0,100] per agent, depletes during work, restores in break room.                    | hooks **#335**|
| S13 | Need-driven auto-routing                | `working / resting / walking` FSM extending current pace machinery.                 | new           |
| S14 | Tutorial overlay system                 | Step-by-step guidance with highlights. Persists in save so it doesn't replay.       | new           |
| S15 | Pattern Sorting (default work room)     | Pre-built at game start. The MDR analogue.                                          | new (content) |
| S16 | Save schema additions                   | Roster, build state, currency, **XP + tier**, tutorial progress, energy.            | extends store |

### 7.4 Build clusters (revised)

Same 7 clusters as before, with XP folded into cluster 4:

1. **Foundation** — S15, S11 (as types), S1.
2. **Hire flow** — S2, S3, S4, S5.
3. **Assignment** — S6.
4. **Work + reward + tier-up** — S7, S8, **S9, S9b**. Currency *and* XP/tier-up land together so the build menu can react to unlocks.
5. **Build loop** — S10. Tier-aware build menu.
6. **Behavior loop** — S12, S13.
7. **Polish** — S14, S16.

After cluster 4 the player has earned ¤ + a tier-up but can't yet build the Break Room (cluster 5 ships placement). After cluster 5 they can build it; without cluster 6 the energy bar isn't there to motivate it. Cluster 7 wraps it all in tutorial guidance.

---

## 8. Open questions / risks

- **Off-shift representation.** Where do off-shift characters "live" in the data model? Are they in `agents` with a `present: false` flag, or moved to a separate roster? Affects how the existing render loop, focus card, and tag registry behave when ~half the cast is invisible at any moment.
- **Innie / outie split.** Severance's signature is the memory split. Do our characters have two persona layers? Cheap version: just say their `about` text covers their innie identity and a separate `outie_about` exists but is unseen. Expensive version: two narrative state graphs per character, story director context-switches.
- **Story director scope creep.** The director currently designs for Sims gossip. Shelter wants tier-aware mystery, persistent threads across days, and a tonal lock (Severance's clinical/uneasy voice). Worth a per-mode prompt rather than retrofitting one director.
- **Tier-up pacing.** Time-to-tier is the hardest dial — too fast and the mystery dilutes; too slow and players don't feel motion. Need real numbers from playtest.
- **Backwards compatibility with #285 / #295 / #325 / #335.** Each adjacent task has assumptions baked in. Multi-room building (#285) currently assumes residence; we now want shifts. Currency (#325) was designed standalone; now it's downstream of tier-up. Worth a follow-up pass on each ticket once §4 is locked.
- **Aesthetic.** Severance's visual language is sterile, retro, fluorescent, mid-century corporate. Our current diorama is warm wood + soft pendants. Tier 1 can stay warm; deeper tiers should drift colder / brighter / more uniform. The shift in lighting is itself a progression signal.

---

[^fs-wiki]: https://en.wikipedia.org/wiki/Fallout_Shelter
[^fs-special]: https://fallout.wiki/wiki/Fallout_Shelter_SPECIAL
[^fs-rooms]: https://fallout.wiki/wiki/Fallout_Shelter_Rooms
[^fs-chars]: https://fallout.wiki/wiki/Fallout_Shelter_Characters
[^fs-pets]: https://gamerant.com/fallout-shelter-how-get-use-find-nuka-cola/
[^esc-uesp]: https://en.uesp.net/wiki/Castles:Castles
[^esc-rulings]: https://en.uesp.net/wiki/Castles:Rulings
[^esc-resources]: https://en.uesp.net/wiki/Castles:Resources
[^esc-quests]: https://en.uesp.net/wiki/Castles:Quests
[^esc-traits]: https://en.uesp.net/wiki/Castles:Traits
[^esc-marriage]: https://en.uesp.net/wiki/Castles:Shrine_of_Mara
[^esc-bs]: https://www.bluestacks.com/blog/game-guides/the-elder-scrolls-castles/tesc-tips-tricks-en.html
[^pl-compare]: https://www.pocket-lint.com/si-the-elder-scrolls-castles-more-than-a-fallout-shelter-reskin/

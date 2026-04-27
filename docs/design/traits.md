# Traits — durable identity that modulates behavior

The bridge between [moodlets](storyteller.md#31-moodlet) (event-driven, short-lived) and [character bibles](vertical-slice.md#1-audience) (`about` text, hand-authored). Traits are durable identity entries that affect *how the world hits a character* — the same event can produce different moodlet weights, different need-decay multipliers, different prompt framing, depending on which traits the character carries.

This doc completes the picture started in [`storyteller.md` §6 (trait promotion)](storyteller.md#6-trait-promotion--turning-mood-into-identity), which described *acquiring* traits. Here we cover what traits actually *do*.

The taxonomy now spans five narrative-state objects (threads, arcs, loops, ambitions, quests) plus two character-state surfaces:

| Surface | Lifespan | Mutates how |
|---|---|---|
| **Needs** | per-tick decay | universal pressure |
| **Moodlets** | hours–days | summed into mood band |
| **Traits** *(this doc)* | months–life | modulates needs decay, moodlet weights, prompt framing |
| **Ambitions / Quests** | months / sessions | character-emanating volition |

---

## 1. What a trait *is*

A trait is a one-line entry on a character with a stable identifier and a small set of declarative effects. Stored as part of the character manifest:

```ts
type Trait = {
  id: string                  // canonical: snake_case ("athletic", "hospitable", "resentful_of:bob")
  label: string               // human: "Athletic", "Hospitable", "Resentful of Bob"
  acquired_at: number         // ms epoch (for UI sort + memorial)
  source: "creation" | "promoted" | "card" | "user"
  // Optional — most traits ship with at least one of these.
  effects?: TraitEffects
  // For relational traits, the other character involved.
  related_pubkey?: string
}

type TraitEffects = {
  // Per-axis decay multiplier. 1.0 = unchanged, 0.5 = decays half
  // as fast, 1.5 = decays 50% faster.
  needs_decay_multiplier?: { energy?: number, social?: number }
  // Per-tag moodlet-weight multiplier. Same event hits this character
  // harder or softer than baseline. Pattern matching mirrors moodlets'
  // clearByTag (`*` wildcards allowed).
  moodlet_weight?: Array<{ match: string, multiplier: number }>
  // Hard-coded prompt fragment injected after the `about` block.
  // Brief — one line per trait. The LLM's interpretation does the work.
  prompt_line?: string
  // Card eligibility — rare traits may unlock or block specific cards.
  card_tags?: { unlocks?: string[], blocks?: string[] }
}
```

Traits live in `character.traits[]` next to `about`. Append-only by default; explicit removal happens through arcs / cards / user action.

---

## 2. Two flavors

**Constitutional traits** (rare, persistent) — acquired at creation or via a major arc. They *describe how this character is wired*. Examples:

- `athletic` — *Athletic. Energy decay × 0.7.*
- `solitary` — *Quiet by nature. Social decay × 0.5.*
- `restless` — *Energy decay × 1.3, but cheerful when active.*
- `hospitable` — *Welcomes new arrivals warmly; gains +50% on `welcomed` moodlets.*
- `apologetic` — *Apologizes for things that aren't her fault.*
- `night_owl` — *Energy decay × 0.5 between 22:00 and 04:00; ×1.5 between 06:00 and 10:00.*

**Relational traits** (acquired in play) — bind to another character. Promoted from sustained moodlet patterns ([`storyteller.md` §6](storyteller.md#6-trait-promotion--turning-mood-into-identity)).

- `resentful_of:bob` — *Negative moodlets tagged `:by_bob` × 1.4.*
- `close_to:alice` — *Positive moodlets tagged `:by_alice` × 1.3; baseline social need slows when alice is in scene.*
- `rivals_with:carl` — *Both characters' moodlets in scenes-with-the-other gain ±20% intensity.*
- `grateful_to:alice` — *One-shot bonus on the next `helped_by:alice` event; expires when called in.*

The audience-tuning principle from [`vertical-slice.md` §3](vertical-slice.md#3-tonal-calibration) applies: most relational traits should be *endearing*. `close_to:`, `comfortable_with:`, `quietly_amused_by:` outweigh `resentful_of:` 4:1 in the promotion table.

---

## 3. How traits modulate

### 3.1 Needs decay

`needs.js`'s `tickAll()` reads the active trait list per character and multiplies `decayPerMin[axis]` accordingly. Multiple multipliers compose multiplicatively (`0.7 × 0.9 = 0.63`).

```js
function effectiveDecayPerMin(character, axis) {
  let rate = DEFAULTS.decayPerMin[axis]
  for (const t of character.traits || []) {
    const m = t.effects?.needs_decay_multiplier?.[axis]
    if (typeof m === 'number') rate *= m
  }
  return rate
}
```

Concrete: an `athletic + solitary` character drains energy at 70% of baseline (back to ~34 sim-hours to zero) and social at 50% (96 sim-hours = 4 days to zero). A `restless` character drains energy faster and is therefore tuned to enjoy *physical* activity affordances when those land in #245.

### 3.2 Moodlet weights

The moodlet emit path consults trait multipliers before storing the final weight:

```js
function weighMoodlet(character, raw) {
  let weight = raw.weight
  for (const t of character.traits || []) {
    for (const rule of t.effects?.moodlet_weight || []) {
      if (matchTag(raw.tag, rule.match)) weight *= rule.multiplier
    }
  }
  return Math.max(-99, Math.min(99, Math.round(weight)))
}
```

This is the [Dwarf Fortress pattern](../research/mood-systems.md#dwarf-fortress--thoughts-and-stress): same event, different valence per character. A `loyal` character weights `witnessed_death:*` more heavily; a `brave` character less. The card pool authors a single moodlet emission; traits make it *land differently per character*.

### 3.3 Prompt framing

Every trait with a `prompt_line` injects one short line into the user-turn prompt, after the character's `about` block:

```
About: Marisol is a careful baker who likes the apartment to be quiet.
Your traits:
  - Hospitable. You welcome new arrivals warmly, even before you decide to.
  - Loves the apartment before anyone is up. (You earned this trait by spending six mornings with the kettle.)
```

Wording for `prompt_line` is the trait author's responsibility — it's the LLM's only direct view of the trait. Keep them short, second-person, and earned-feeling. Bad: *"+30% positive moodlet weight on shelter:* events"*. Good: *"You welcome new arrivals warmly, even before you decide to."*

### 3.4 Card eligibility

Card frontmatter can require / forbid specific traits:

```yaml
required_traits: ["hospitable"]    # only fires when one resident is hospitable
forbidden_traits: ["solitary"]     # never fires for solitary characters
```

This lets cards like `card.bake_for_neighbor` only fire for characters whose `about` + acquired traits actually motivate them.

---

## 4. Acquisition

Three paths, in order of frequency:

1. **At creation** — when a user creates a character, the bridge runs an LLM call: *"Read this `about`. Propose 1-2 constitutional traits that fit, drawn from this curated list."* The user sees + edits before commit. (Same shape as [`quests-ambitions.md` §3.1](quests-ambitions.md#31-ambition-creation) for ambition seeding.) Rare/exotic traits aren't auto-suggested — only the curated default catalog.
2. **Promoted from moodlets** — [`storyteller.md` §6](storyteller.md#6-trait-promotion--turning-mood-into-identity) runs at session_close. Pattern-matches recurring or sticky moodlets against a promotion table; emits a `trait_promoted` perception event so witnessing characters can react.
3. **Card-driven** — a card with `add_trait:` in its action list. The `arc.tomek-tournament` resolution might add `won_something_small` to Tomek if he placed.

User-driven trait edits (via the Profile drawer) are a debug surface — fine for testing, but not part of the player-facing loop.

---

## 5. UI

The Profile drawer's Vitals panel adds a **Traits** subsection beneath moodlets:

```
┌─ Traits ───────────────────────────────────┐
│ ◇ Athletic                       (creation)│
│ ◇ Loves the apartment            (promoted │
│   before anyone is up.            day 6)   │
│ ◇ Resentful of Bob               (promoted │
│                                   day 12)  │
└────────────────────────────────────────────┘
```

Hover on a trait shows its `prompt_line` + effects summary ("energy decay × 0.7"). Click to open the source — for promoted traits, that's the moodlet pattern that triggered promotion + a link to the session.

---

## 6. Curated catalog (v0)

Ship slice 1 with this set — small enough to author thoroughly, broad enough to give characters texture:

**Constitutional (eligible for creation-time seed):**

| id | label | needs_decay | prompt_line |
|---|---|---|---|
| `athletic` | Athletic | energy ×0.7 | "You stay active. Routine motion clears your head." |
| `solitary` | Solitary | social ×0.5 | "You don't need company to feel right." |
| `restless` | Restless | energy ×1.3 | "Stillness costs you. You'd rather be moving." |
| `hospitable` | Hospitable | — | "You welcome new arrivals warmly, even before you decide to." |
| `apologetic` | Apologetic | — | "You apologize for things that aren't yours to apologize for." |
| `night_owl` | Night owl | energy ×0.7 (22-04), ×1.3 (06-10) | "Mornings are not your time." |
| `morning_person` | Morning person | inverse of night_owl | "You like the apartment before anyone is up." |
| `careful` | Careful | — | "You think before you speak. Sometimes you don't speak." |
| `dry` | Dry | — | "Your humor is dry. Most people miss half of it." |
| `warm` | Warm | — | "You make people feel held without saying much." |

**Promoted-only** (acquired in play):

| id | label | trigger pattern |
|---|---|---|
| `loves_quiet_mornings` | Loves the apartment before anyone is up | 6+ `discovered_morning_quiet` over 14 days |
| `apologizes_for_apologizing` | Apologizes for apologizing | 8+ `apologized_unnecessarily` |
| `insomniac` | Insomniac | 10+ `slept_poorly` over 14 days |
| `resentful_of:<X>` | Resentful of X | 5+ negative `:by_X` over 30 days |
| `close_to:<X>` | Close to X | 20+ positive `:by_X` over 30 days |
| `grateful:<context>` | Grateful (context) | 1× sticky `was_helped_with:<context>` for 7+ days |

These are starter values — the exact thresholds are tuning knobs in [`storyteller.md` §6](storyteller.md#6-trait-promotion--turning-mood-into-identity)'s promotion engine.

---

## 7. Why traits matter

Without traits, every character feels the world identically. Energy decay is the same; moodlets weight the same; their `about` text is the only differentiator and it's frozen at creation.

With traits:

- Identity *grows* — Marisol who started "a careful baker" becomes "a careful baker who loves the apartment before anyone is up, who's still a little resentful of Bob since last week."
- The LLM's prompt picks up the new texture without re-engineering — `prompt_line` injection is two lines of code.
- The same card scripts work for everyone because traits do the per-character coloring.
- The audience's compounding-investment hook ([vertical-slice.md §1](vertical-slice.md#1-audience)) lands: characters at Day 30 are different from Day 1, in *visible* ways.

---

## 8. What this isn't

- Not a stat block. No numeric "agility" / "intelligence" axes. Traits are *named adjectives*, not RPG stats.
- Not a class system. Characters can carry as many traits as they earn; there's no exclusivity.
- Not a power curve. Trait effects are tuned to be subtle — `energy ×0.7` and `moodlet weight ×1.3` are typical caps. Nothing gives a character a 5× bonus to anything.
- Not permanent identity-locking. Promoted traits can be *replaced* by counter-arcs (e.g. `resentful_of:bob` cleared by a reconciliation arc that adds `forgave:bob`).

---

## 9. Open questions

1. **Trait stacking conflicts.** What happens when `morning_person` and `night_owl` both apply? Multiplicative composition gives a flat 0.91 — close enough to 1.0 that the conflict cancels out. Acceptable, or should the promotion engine reject promoting an opposite of a constitutional trait?
2. **Visibility.** Do other characters see each other's traits in their LLM prompt? My take: *only the prompt_line of relational traits where they're the related_pubkey* (so Bob sees "Cleo seems guarded around me lately" if Cleo has `resentful_of:bob`). Constitutional traits stay private.
3. **User-authored exotic traits.** Beyond the curated catalog, can the user add freeform traits? Probably yes via the Profile drawer (debug surface). The promotion engine never auto-promotes outside the catalog.
4. **Trait sunset.** Should some promoted traits *expire* if their reinforcing pattern stops? E.g. `resentful_of:bob` fades after 60 days of no negative `:by_bob` moodlets. Probably yes — closes the loop; lets characters heal.
5. **Effect ceiling.** Cap multipliers to 0.5..2.0 to keep things tunable, or allow extreme values for exotic traits? Default cap to 0.5..2.0; extreme values via opt-in. 

---

## 10. Implementation order

Lands as task [#335](../../tasks/335-traits-system.md):

1. **Schema** — `character.traits[]`, persistence (in the existing character JSONL), HTTP endpoints `GET/PATCH /characters/:pubkey/traits`.
2. **Effects pipeline** — `applyTraitMultipliers(character)` helpers consumed by `needs.js` and `moodlets.js`.
3. **Prompt injection** — `formatTraitsBlock(character)` in `buildContext.js`, added after `about`.
4. **Curated catalog** — `agent-sandbox/pi-bridge/traits.js` with the 10 constitutional + 6 promoted entries above.
5. **Creation-time seed** — when a character's `about` is generated, propose 1-2 constitutional traits via an LLM call against the curated list.
6. **Promotion engine** — wires the moodlet-pattern promotion rules from [`storyteller.md` §6](storyteller.md#6-trait-promotion--turning-mood-into-identity) into the session_close hook.
7. **UI** — Traits subsection in the Profile drawer; clickable for source; trait chip in the recap card when newly promoted.

Slices 1-3 are the testable foundation; 4-7 add the visible loop.

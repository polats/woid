---
name: World — Trait promotion and memorial
description: Long-running moodlet patterns and established loops promote to durable traits on a character's `about`. Departed characters get persistent memorial state. The bridge between short-term mood and long-term identity.
status: todo
order: 315
epic: world
depends_on: [275, 295]
---

The audience-tuning principle from [vertical-slice.md](../docs/design/vertical-slice.md) is that compounding investment is what brings users back on Day 7. The bridge between short-term events (moodlets) and long-term identity (traits, relationships, memorialized characters) is what makes a Day-7 character meaningfully different from a Day-1 one.

Specified in [docs/design/storyteller.md §6 and §7](../docs/design/storyteller.md#6-trait-promotion--turning-mood-into-identity).

## Slices

### Slice 1 — Promotion rules engine

- New `agent-sandbox/pi-bridge/storyteller/promotion.js`.
- Rule definitions per [docs/design/storyteller.md §6](../docs/design/storyteller.md#6-trait-promotion--turning-mood-into-identity): `{ match: <tag pattern>, count?: N, window?: ms, sticky_days?: K, trait: (ctx) => string }`.
- Run at session_close. Match against the moodlet log + active loops from [#295](295-narrative-state.md).
- On promotion: append a one-line entry to `character.about.traits[]`, emit a `trait_promoted` perception event, and clear the triggering moodlets.
- Author 8–10 starter rules covering insults (`Resentful of <X>`), close friendship (`Close to <X>`), poor sleep (`Insomniac`), shelter received (`Grateful (<context>)`), morning ritual (`Loves the apartment before anyone is up`), apologetic recurrence (`Apologizes for apologizing`).

### Slice 2 — Loop-driven promotion

- A loop with `promotion_score ≥ 0.7` that's `established` becomes a candidate.
- Manual approve via the Stories panel, or auto-promote behind a config flag.

### Slice 3 — UI

- `AgentProfile.jsx` Vitals panel adds a Traits subsection listing the promoted traits with date acquired.
- Stories panel "Established loops" view gets a Promote button.
- A toast notification fires on promotion: *"Marisol is now considered to love mornings."*
- Recap pipeline gets a hint to lead with the promotion if it happened today.

### Slice 4 — Memorial / departure

- New verb `DespawnTag` (already declared in #305 action DSL) finishes the departure flow:
  - Move character record to `$WORKSPACE/memorial/<pubkey>.json` with tombstone snapshot.
  - All moodlets on others tagged `by:<pubkey>` get converted to memorial moodlets (`tag: misses:<pubkey>`, weight halved, expiry doubled, sticky).
  - Emit `departure` perception event.
  - Recap leads with the departure.
- New `src/Memorial.jsx` — page listing departed characters with their final recap line and accumulated traits.

### Slice 5 — Tonal guardrails

- The 70/25/5 audience-tuning principle requires that promoted traits skew **endearing**, not grim.
- Author rules with this calibration: most rules promote positive or quirky traits; only the 5% drama-tier produces grim traits.
- Test: ship a 30-sim-day torture run; in the resulting trait distribution, < 20% of promoted traits should be grim.

## Acceptance

- After 6 sim-days of Marisol using the kettle every morning (loop reaches `established`, observation count ≥ 7), her `about.traits` gains "Loves the apartment before anyone is up" and the moodlet history is cleared.
- After 5 `insulted_by:bob` moodlets in 14 sim-days on Cleo, her `about.traits` gains "Resentful of Bob" and a `trait_promoted` perception event fires.
- The trait shows up in subsequent character turn prompts and visibly affects LLM line choices.
- A character departing leaves a memorial record; other characters' moodlets referencing them are converted to `misses:<pubkey>` memorial entries; the next recap mentions the departure.
- The Memorial page shows departed characters in chronological order; clicking opens the tombstone with their accumulated traits and final recap.

## Non-goals

- Trait *removal* (de-promotion) — once promoted, traits stick. A separate redemption-arc feature is v2.
- Death (as opposed to departure) — defer; the audience contract is "characters leave, rarely die."
- Memorial-character revival — once departed, gone. (Their data persists; they can be referenced; they don't return.)

## Risk notes

- Promotion rule tuning is the audience-trust pivot. Get the calibration wrong and characters either never change (no compounding investment) or change too much and lose continuity. Start conservative; ship with a debug overlay showing the rule-evaluation log per session_close.
- Moodlet→trait migration must be idempotent — re-running the promotion engine on the same data shouldn't re-promote.
- The "memorial moodlet" conversion is irreversible from the user's perspective; warn before user-initiated departures.

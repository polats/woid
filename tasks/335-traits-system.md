---
name: World — Traits system (durable identity that modulates behavior)
description: Per-character trait list that modulates needs decay, moodlet weights, and prompt framing. Acquired at creation, promoted from moodlet patterns, or card-driven. The bridge between event-driven moodlets and hand-authored character bibles.
status: todo
order: 335
epic: world
depends_on: [275, 295, 305]
---

Specified in [docs/design/traits.md](../docs/design/traits.md). Closes the loop sketched in [storyteller.md §6](../docs/design/storyteller.md#6-trait-promotion--turning-mood-into-identity) — that doc described *acquiring* traits via promotion; this one describes what traits *do* once acquired.

The audience-tuning principle: characters at Day 30 should *feel different* from Day 1 in visible ways. Without traits, every character experiences the same need-decay rates and the same moodlet weights — the only differentiator is `about`, which is frozen at creation. Traits let identity *grow*.

## Slices

### Slice 1 — Schema + storage

- Extend the character manifest with a `traits[]` array (per [docs/design/traits.md §1](../docs/design/traits.md#1-what-a-trait-is)).
- HTTP: `GET /characters/:pubkey/traits`, `POST /characters/:pubkey/traits`, `DELETE /characters/:pubkey/traits/:traitId`.
- Persistence: lives in the existing character JSON file alongside `about` and `needs`.

### Slice 2 — Effects pipeline

- `agent-sandbox/pi-bridge/traits.js` — pure module with the curated catalog (10 constitutional + 6 promoted-only entries from [docs/design/traits.md §6](../docs/design/traits.md#6-curated-catalog-v0)).
- `applyTraitMultipliers(character, axis)` — used by `needs.js` `tickAll()` to compute the effective decay rate.
- `weighMoodlet(character, raw)` — used by `moodlets.js` `emit()` to multiply the raw weight before storage.
- Both functions accept the character record (with `traits[]`) and apply multiplicative composition.

### Slice 3 — Prompt injection

- `formatTraitsBlock(character)` in `buildContext.js`, injected after the `about` block. Each trait's `prompt_line` becomes a one-line bullet (omit traits without prompts).
- Relational traits (`resentful_of:<X>`) — in slice 1 they only surface to the carrier; visibility to the related character is a slice-7 polish.

### Slice 4 — Creation-time seed

- When a character's `about` is generated (or PATCHed), run an LLM call: *"Read this `about`. Propose 1-2 constitutional traits from this list that fit."*
- User reviews and confirms before commit. Skip-able via UI.

### Slice 5 — Promotion engine

- `agent-sandbox/pi-bridge/storyteller/promotion.js` — runs at session_close (already wired in [#275 slice 2](275-storyteller-foundation.md)).
- Pattern-matches against the moodlet log + active loops (when [#295](295-narrative-state.md) ships). Applies the rules table from [docs/design/traits.md §6](../docs/design/traits.md#6-curated-catalog-v0).
- On promotion: appends to `character.traits`, emits a `trait_promoted` perception event, clears the triggering moodlets.

### Slice 6 — UI

- New "Traits" subsection in the Profile drawer's Vitals panel ([per docs/design/traits.md §5](../docs/design/traits.md#5-ui)).
- Hover shows `prompt_line` + effects summary; click opens the source (the moodlet pattern that promoted it, with a link to the session).
- Recap card shows a chip when a trait was promoted today.

### Slice 7 — Card eligibility + relational visibility

- Card frontmatter `required_traits` / `forbidden_traits` (#305 dependency).
- Relational traits where the related_pubkey is another character — that character's prompt sees a brief "Cleo seems guarded around you lately" line.
- Optional trait-sunset: relational traits fade if their reinforcing pattern stops for N days.

## Acceptance

- Adding `athletic` to a character measurably slows their energy decay (verified via `/health/needs` over a sim-day).
- Adding `apologetic` causes the LLM to produce more apologetic line choices (manual graded against the prompt-line wording).
- A character that accumulates 5+ `insulted_by:bob` over 14 sim-days gets `resentful_of:bob` promoted at session_close, clearing the triggering moodlets and emitting a perception event.
- The Profile drawer's Traits subsection lists the trait + acquired_at + source.
- Bridge has a unit test for `applyTraitMultipliers` (multiplicative composition; clamping; missing-effects no-op) and `weighMoodlet` (tag-pattern matching, ±50% caps).

## Non-goals

- Numeric stat blocks (agility / intelligence / etc). Traits are named adjectives, not RPG stats.
- A class / archetype system. Characters carry as many traits as they earn; no exclusivity.
- Backwards-compat for legacy `personality` / `vibe` fields — those were already dropped in [#275](275-storyteller-foundation.md).
- Player-authored exotic traits as a first-class flow. Curated catalog only for slice 1; freeform is a debug surface.

## Risk notes

- Effect ceiling matters: multipliers should cap at 0.5..2.0 by default. Extreme values via opt-in only — the audience contract (subtle differentiation, not hero-shaped power curves) breaks if a character can decay 5× slower than baseline.
- Trait stacking can cancel itself out (`morning_person` + `night_owl` ≈ 1.0). Acceptable; promotion engine should still allow the conflict and let the LLM-prompt-line readers find it weird if they want.
- The LLM proposing creation-time traits is a quality-sensitive prompt. Use few-shot of 5-8 (about, traits) examples to stabilize. Cache the result so PATCHes to `about` don't re-fire the call unless the user asks.

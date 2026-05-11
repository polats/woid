---
name: World — Spell injections that affect the environment
description: User-triggered "spells" that inject events into a running sandbox session to perturb the world — change weather, time of day, mood, drop an object, force a need spike on a character. Surfaced as a small caster panel; logged as first-class events so storyteller / recap pick them up.
status: todo
order: 465
epic: world
related: [225, 235, 245, 275, 295]
---

Right now the sandbox runs autonomously — agents act on their schedules, perception, and needs (#235), grounded in smart objects (#245). There's no clean way for a watching user to nudge the world without editing state by hand. "Spells" give the user a vocabulary of pre-defined environment perturbations that flow through the same event pipeline as agent actions, so storyteller (#275) and narrative state (#295) can react.

## Slices

### Slice 1 — Spell catalog + event shape

- `src/spells/catalog.js` — array of spell defs:
  ```js
  { id, name, description, category, params: [...], effect(ctx, params) }
  ```
- Categories: `weather` (rain, fog, clear), `time` (skip-to-dusk, freeze-clock-5min), `mood` (calm, tense), `objects` (drop-item, break-item), `character` (force-need: hunger|fatigue|social, plant-thought).
- Effects emit one or more `kind: "spell"` events with `{ spell_id, caster: "user", params, target?, sim_iso }`. Events go through the same path as agent actions so they land in the session log, recap, and storyteller context.

### Slice 2 — Bridge endpoint

- `POST /spells/cast { spell_id, params }` — validates against the catalog, applies the effect to the live session state, emits the event(s), returns `{ event_id, applied: {...} }`.
- `GET /spells` — returns the catalog (id, name, description, param schema) for the UI.
- Rate-limit per session (e.g. 1 cast / 5s) to avoid spamming the storyteller context.

### Slice 3 — Caster panel UI

- New tab or drawer section in the Sandbox view: searchable list of spells grouped by category. Selecting one reveals a small param form (target character picker for character spells, item picker for object spells, etc.) and a "Cast" button.
- Recent-casts log at the bottom showing the last 10 casts with their effect summary.
- Toast on success / failure.

### Slice 4 — Agent perception of spells

- Spell events are visible to agent perception the same way ambient world events are. A "rain" spell flips the world weather flag that schedule/needs already read. A "force-need: hunger" spell raises the target character's hunger meter, which their next planning tick will react to.
- Storyteller prompt receives recent spell events as part of session context so recaps acknowledge them ("the sky darkened suddenly and Maya headed inside").

## Acceptance

- Casting `weather:rain` from the panel changes the world weather flag within one tick and at least one agent reacts on their next planning step (e.g. moves indoors, comments on it).
- Casting `character:force-need:hunger` on a target spikes that character's hunger and their next action reflects it.
- Spell events appear in the session event log with `kind: "spell"`, `caster: "user"`, and the right params.
- Storyteller recap for a day with casts mentions at least one of them.
- Rate limit blocks bursts cleanly with a 429.

## Non-goals

- Agents casting spells on each other.
- Persistent / scheduled spells (e.g. "rain for the next 30 min" beyond a single flag flip).
- A scripting language for custom spells — catalog is hand-curated for now.
- Visual effects on the stage (particles, etc.) — text/state changes only.

---
name: Bug — say_to: recipient "You (X, Y)" not found in room
description: Characters occasionally try to address themselves by parsing "You" out of the roster line. The GM rejects it correctly, but the noise pollutes logs and burns a turn. Filter the roster so the self entry doesn't read like another character.
status: done
order: 405
epic: world
related: [225]
---

Seen in prod logs:

```
[actions:ag_553sjqqg] say_to rejected: recipient "You (2, 2)" not found in room
```

The user-turn prompt's roster block currently includes the self entry like:

```
Others in the room:
  - You (2, 2)
  - Tally Velez (8, 7)
```

The model sometimes parses `You` as a recipient name and emits `say_to(recipient: "You", text: "...")`. The GM's recipient resolver looks up "You" in the room presence list, fails to find it (the name is the actual character's name, not "You"), and rejects.

This is a prompt-cleanup issue. Two fixes:

## Slices

### Slice 1 — Strip self from "Others" roster

In `buildContext.js`, the agents-in-room loop should already skip the self entry — verify. If not, add the filter. The "You are at (X, Y)" line above the roster is the dedicated self-anchor; the roster shouldn't repeat it.

### Slice 2 — `say_to` recipient validation friendlier

If the recipient resolves to the actor itself (by name match or by pubkey), reject with a clearer reason — "you can't say_to yourself; use `say` for thinking out loud" — and don't burn the turn. Today rejection still consumes the action; the next turn fires normally so the cost is small but the log noise is annoying.

### Slice 3 — Test

Unit test in `gm.test.mjs` that emitting `say_to({recipient: ctx.name, text: "x"})` returns `{ ok: false, reason: ... }` with the new reason text and doesn't throw.

## Acceptance

- Prod logs no longer show `say_to rejected: recipient "You (X, Y)"` errors.
- A character can still emit `say` and `say_to(other)` correctly.
- Existing tests pass; new test for the self-recipient case passes.

## Non-goals

- Refactoring the roster block format.
- Auto-correcting self-recipient to `say` (silently). Better to reject so the LLM learns; the rejected-action perception event surfaces the lesson.

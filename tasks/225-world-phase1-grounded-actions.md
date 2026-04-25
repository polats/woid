---
name: World phase 1 — grounded action layer (verb set + Game Master)
description: Replace free-form LLM action emission with a small finite verb set arbitrated by the server. Every NPC tick emits a typed action; the server validates and applies it before broadcasting. Foundation for all later world-simulation phases.
status: todo
order: 225
epic: world
---

This is phase 1 of the five-phase world plan distilled from `docs/research/`. Each later phase (schedules, smart objects, relationships, LOD) writes through the layer this card builds. Without it, "the agent did X" is just a story the LLM told itself.

The research case for verbs-not-prose: OASIS reached 1M agents with a 21-verb API; Convai's whole production SDK is shaped this way; Concordia's Game Master pattern is the cleanest published answer to "who arbitrates whether an emitted action is grounded?" Free-form action generation costs 10–100× more tokens than verb sets and fails grounding more often (see `docs/research/llm-agents-2025-2026.md` §1, §3).

## Deliverables

### Verb schema

- `agent-sandbox/shared/verbs.js` (or .ts) — single source of truth for the action grammar. Initial set, ~15-20 verbs:
  - Movement: `move_to(target)`, `face(target)`, `wait(seconds)`
  - Object: `pick_up(object)`, `drop`, `use(object)`, `give(object, recipient)`
  - Social: `say(text)`, `say_to(recipient, text)`, `emote(kind)`, `listen`
  - Self: `sit(seat?)`, `stand`, `sleep`
  - Meta: `idle`, `noop`
- Each verb declares: required args, optional args, preconditions (what state must be true to execute), effects (what state changes on success).
- Zod or similar runtime validator so the server rejects malformed actions with a structured error.

### Game Master in the room server

- `agent-sandbox/room-server/gm.js` — receives a typed action from a harness, validates against world state, applies on success.
- Validation checks: target exists, target reachable, NPC owns prerequisite (e.g. `give` requires holding the item), no collision, not in cooldown.
- On failure: returns `{ ok: false, reason }` to the harness; the next perception turn includes the rejection so the LLM can adjust.
- On success: applies the state diff and broadcasts via the existing Colyseus channel.

### Harness contract change

- All three harnesses (pi / direct / external) emit a JSON action object instead of free text for "what to do this turn." Speech is one verb (`say` / `say_to`) among many.
- `buildUserTurn` keeps text perception (it's working — see `docs/research/llm-agent-prior-work.md`); only the *output* shape changes.
- System prompts updated to describe the verb grammar with examples. Keep the prompt short; the schema is the contract.

### Action log

- Every accepted action appended to `turns.jsonl` with `{ ts, pubkey, verb, args, result }`. Replaces the current free-text log.
- `GET /characters/:pubkey/turns` returns the structured log; the inspector renders it as a verb timeline rather than a transcript.

## Acceptance

- A character can execute a 10-action plan (`move_to chair → sit → say "hi" → wait → stand → move_to door → ...`) end-to-end with zero free-text emissions.
- Invalid actions (move to nonexistent target, sit on occupied seat) are rejected with a structured error and the agent recovers on the next turn.
- All three harnesses pass an "emits valid verb JSON" test against the existing test character.
- Per-action token cost drops measurably vs. free-form (capture before/after in the dashboard from #185).
- The inspector's per-turn view shows the verb + result, not just the prose.

## Non-goals

- Smart Objects advertising affordances (#235 — phase 3).
- Schedule-driven verb selection (#235's prereq #225-adjacent — phase 2 #235-of-this-track, see below).
- Per-verb animations (verb just becomes a tag the renderer can switch on later).
- Multi-step planning by the GM (it validates one action; planning is the agent's problem).

## Risk notes

- Verb-set bikeshedding: keep the initial list small. We can add verbs as needs arise; we cannot easily remove them once agents depend on them.
- Backwards compatibility: this is a breaking change for existing characters. Migrate the test character first; older session logs stay readable but stop being appended to.
- Don't over-engineer the precondition system. Start with imperative checks in `gm.js`; only extract a declarative engine if a second world type appears.

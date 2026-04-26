---
name: World phase 1 — autonomous two-agent sandbox (verb set + GM + scenes + journal)
description: Foundation for everything later. Drop two LLM characters in a room, walk away, come back later, find that something interesting happened. Verb registry + Game Master + scene awareness + persistent scene transcripts (journal) + Nostr decoupled into deliberate `post` verb only.
status: done
order: 225
epic: world
---

Originally scoped as just "verb set + GM." Rescoped after the design exploration in `docs/research/tomodachi-life.md` (addendum) and the multi-session conversation that followed it.

The new framing: **drop two LLM characters into the existing room, walk away, come back later, find that something interesting happened.** Every primitive in this card is general infrastructure that supports many possible product shapes (Tomodachi-like, haunted-house, social-network, anything else) — none of it is committed to a specific game design.

The two design calls underneath this scope:

1. **No LLM summarizer.** Scene records are full raw transcripts. Memory of past scenes = the LLM reading its own past words verbatim. Cheaper, no quality variance, no "the summarizer got it wrong" failure mode.
2. **Nostr is reserved for deliberate social posts.** In-scene speech (`say` / `say_to`) is private to the scene transcript. Only the new `post` verb publishes to the relay. Characters get two registers: their actual life (private journal) and what they choose to broadcast (public Nostr).

Research case: OASIS reached 1M agents with a 21-verb API; Concordia's GM pattern is the cleanest published answer to "who arbitrates whether an emitted action is grounded?"; Park 2024's 1052-person study showed grounding identity in rich biography retrieved as one block beats prompt-only persona scaffolding (see `docs/research/llm-agents-2025-2026.md`). The journal-injection-as-memory pattern is HiAgent's subgoal-chunked working memory done with raw transcripts instead of summaries.

## Deliverables

### Verb registry

`agent-sandbox/shared/verbs.js` — single source of truth for the action grammar. Ten verbs total:

```
say(text)                        — speak in current scene; private to scene
say_to(recipient, text)          — addressed speech in scene
move_to(target | x, y)           — pathing on the grid
face(target)                     — turn toward another agent or position
wait(seconds?)                   — explicit pass-time
emote(kind)                      — gesture / expression
set_state(text)                  — internal mood/context note
set_mood(energy?, social?)       — quantized 0-100 levers
post(text)                       — public social post → Nostr kind:1
idle                             — explicit no-op
```

Each verb declares: required args, optional args, preconditions (what state must be true), effects (what changes on success). Runtime validator (zod or similar) so the GM rejects malformed actions with a structured error.

### Game Master in the bridge

`agent-sandbox/pi-bridge/gm.js` — receives typed actions from any harness, validates, applies on success.

Validation checks: target exists, target in scene (for `say_to`), text within length cap, post rate-limit not exceeded, etc. On failure: returns `{ ok: false, reason }`; the next perception turn includes the rejection so the LLM can adjust. On success: applies the state diff and routes to the right commit path:

- `say` / `say_to` → Colyseus broadcast + scene transcript append. **Not relayed.**
- `move_to`, `face`, `set_mood`, `set_state`, `emote`, `wait`, `idle` → state mutation, broadcast.
- `post` → bridge signs kind:1 with the character's key, publishes to relay. **Only Nostr-bound verb.**

The GM lives in the bridge (not the room server) because the bridge already owns identity, manifests, and the relay-publish path; it's the natural single chokepoint.

### Harness contract change

All three harnesses (pi / direct / external) emit a JSON `actions` array instead of the current keyed turn object. Speech is one verb among many. `buildUserTurn` keeps text perception (it works); only the output shape changes.

System prompts (`dynamic`, `minimal`) updated to describe the verb grammar with examples. Crucial: clarify that `say` is in-room speech (private to the scene) and `post` is for public social media (rare, deliberate).

### Perception event ring buffer

Per-character typed event log of what they observed since their last turn. Sources:

- Speech events from scene-mates (`speech`)
- Movement events from agents entering/leaving view (`movement`, `presence`)
- Scene boundary events (`scene_open`, `scene_close`)
- GM rejections (`action_rejected` — own attempted action that failed)
- Future: schedule events, environmental events, etc.

Ring-buffered to last ~50 entries. `buildUserTurn` reads this stream + filters for "since this character's last turn" + injects as a "since you last acted" block in perception.

### Scene awareness

When two characters are within N tiles (default 3, configurable), the room server flags them as **in a scene together** and broadcasts the scene state via Colyseus. The bridge consumes this flag to:

- Adjust tick cadence: alone → 30-60s; in scene → 5-10s alternating.
- Validate `say_to` targets (must be in scene).
- Emit `scene_open` / `scene_close` perception events.

Proximity-based grouping is general infrastructure — not Tomodachi's "hallway" specifically. Tomodachi-like products would also use it; haunted-house would use it; pure social-network products wouldn't. Cheap to add now.

### Conversation gate

Without a deterministic stop, two LLMs in a scene burn calls forever. The gate is rule-based, no meta-LLM:

- **Random length budget**: each scene rolls 4-8 at open. After the budget, the next turn must be a non-speech verb.
- **Soft-stop**: two consecutive `wait` or `idle` actions across both agents → scene closes.
- **Cooldown**: same pair can't re-form a scene for ~5 minutes real time.
- **Hard cap**: 12 turns absolute.

Each rule emits a perception event so agents *see* the close (`"you finished a long conversation with X — give them space"`).

### Tick orchestrator

Replaces the current fixed-cadence scheduler with a state machine over `(agent_state, scene_state)`:

- Alone, idle: tick every 30-60s, gated by perception-event-arrived.
- In scene: tick every 5-10s, alternating with scene-mates.
- In scene with 3+: round-robin, longest-silent-first.

### Scene transcript storage (journal)

Every scene is recorded in full as a structured turn log:

```js
{
  scene_id,
  ts_start, ts_end,
  participants: [pubkey_A, pubkey_B],
  end_reason: "soft_stop" | "budget" | "proximity_lost" | "hard_cap",
  turns: [
    { ts, actor, verb, args, result },
    ...
  ]
}
```

**No LLM summarization.** The transcript IS the record.

Storage: `$WORKSPACE/scenes.jsonl` (one line per scene). When SQLite lands (#215), promote to a real table. References into the existing `turns.jsonl` for the structured turn data.

### Memory injection — raw past-scene excerpts

When two characters re-encounter, `buildUserTurn` injects the most recent past scenes between them directly into the system context. No paraphrase. The LLM reads its own past words verbatim.

Default budget (tunable):

- Last 2 scenes between this pair (or all if fewer).
- Last 6 turns per scene.
- Hard cap 800 tokens of injected memory per turn (truncate older first).

Format injected as a block at the top of the turn:

```
You and Carlos have spoken before. Recent exchanges:

[Yesterday afternoon, scene #38, ended: soft_stop]
  Marisol: "hi. i moved in a couple hours ago."
  Carlos:  "yeah i heard you closing cabinets. i'm carlos."
  ...

[This morning, scene #41, ended: budget]
  Marisol: "i made too much bread. take some."
  Carlos:  "you didn't have to —"
  ...
```

Drift over time emerges naturally — a character's voice in turn 100 reflects having lived through turns 1-99 because turns 1-99 are literally in the prompt as their own past dialogue.

### Journal view

New view at `#/agent-sandbox/journal`. Scrollable feed of scene cards:

```
┌─────────────────────────────────────────────────┐
│ ⏰ 2 hours ago · 6 turns · ended: soft_stop    │
│  [📷] Marisol  ·  [📷] Carlos                   │
│  ▸ expand                                       │
└─────────────────────────────────────────────────┘
```

Click expand → inline expansion shows the full play-script transcript. Filterable by participant: `?participant=<pubkey>` returns one character's history — readable as an emergent autobiography.

The journal is just a chronological log of scenes — readable in a single session as much as across sessions. No special markers for "while you were away"; players can scroll to whatever timestamp they want.

API on the bridge:

```
GET  /scenes?limit=50&before=<ts>     paginated list
GET  /scenes/:id                      single scene with full transcript
GET  /scenes?participant=<pubkey>     filter by character
```

### Nostr decoupling

Today the bridge publishes a kind:1 for every `say` action. **Stop doing that.**

- `say` / `say_to` → Colyseus + scene transcript append only. Not relayed.
- `post` → kind:1 publish, route through existing `/internal/post` machinery.
- pi-harness's `post.sh` skill becomes the bash equivalent of `post`. Add a new `say.sh` skill that doesn't relay (room broadcast only).
- The relay-feed UI (`#/relay-feed`) keeps working; it'll just show fewer events, all of them deliberate posts.

Existing characters' historical kind:1's stay on the relay as historical record. No data migration.

### Inspector improvements

Three small additions:

- **Scene viewer**: when two agents are in scene, a synthesized panel shows their turns interleaved chronologically, threaded by speech vs. movement.
- **Live event tail**: the perception event ring buffer rendered live.
- **Mini-map**: 16×12 grid showing all agents' current positions with scene boundaries lit up.

## Acceptance

1. Two pre-spawned characters with hand-authored, contrasting personas in the existing room. Tick autonomously without player input.
2. Within ~60s of fresh load, the first interesting moment happens — they're adjacent, one says something, the other responds, scene opens.
3. Conversations bounded by gate: 4-12 turns, ends naturally, no runaway, no token explosion.
4. **Re-encounters reference past scenes.** Their second scene shows verbatim or paraphrased callbacks to earlier dialogue (because the LLM is reading its own past output as memory). No state machine, no relationship type — drift emerges from injected transcript.
5. Characters occasionally emit `post` verbs. The Nostr feed shows these and *only* these. The relay becomes meaningful per-post rather than constant chatter.
6. Journal shows scenes in chronological order, viewable any time during or between sessions. Player can scroll history freely. Nostr feed shows ~3-5 deliberate posts per simulated hour.
7. Reading the full journal of one character feels like reading a play script of their week.
8. All three harnesses (pi / direct / external) pass "emits valid verb JSON" tests against the existing test character.
9. Per-action token cost drops measurably vs. free-form (capture before/after via #185 dashboard).
10. Run for 24 hours unattended. Cost is bounded (no runaway). At least one moment in the journal genuinely surprises the reader.

## Non-goals

- Schedules + needs (#235).
- Smart objects + affordances (#245).
- Relationship state machines (#255). The journal + memory injection give us *legible* relationships without a state machine; phase 4 formalizes them later.
- LOD (#265).
- Tomodachi UI (apartment grid, requests, shop).
- Player intervention verbs (introduce, gift, approve, etc.). Phase 1.5 is **autonomous** — the player is a witness, not a curator. Curatorial verbs come later as one optional layer.
- Richer social verbs (`reply`, `react`, `repost`, `follow`, `unfollow`). Defer to a focused social-network phase.
- DMs / private 1:1 channels outside scenes.
- Multi-room.

## Risk notes

- **Backwards compatibility.** Stopping `say` from publishing kind:1 is a breaking change for the public Nostr feed. Existing followers will see the relay go quiet. Communicate clearly; previous kind:1's stay as historical record.
- **Memory budget creep.** 800-token injection per re-encounter is fine in isolation. Watch the total prompt size when phases 2-4 add their own perception channels. Re-budget if total prelude exceeds ~3k tokens.
- **Conversation gate tuning.** Random budget 4-8 is a guess. Tune from observation in week 2 of the build. Too short = no satisfying exchanges. Too long = repetitive. Make this a runtime config, not a constant.
- **Cost while no one's watching.** Two agents idling at 30-60s ticks burn ~120 LLM calls/hour at minimum. Budget for this; throttle via the orchestrator if measurements show it's untenable. LOD (#265) formalizes the throttle later.
- **Verb-set bikeshedding.** Keep the list at 10. Add verbs as needs arise; we cannot easily remove them once agents depend on them.
- **Don't over-engineer the precondition system.** Imperative checks in `gm.js`. Extract a declarative engine only if a second world type appears.

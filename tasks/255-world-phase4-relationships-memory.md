---
name: World phase 4 — relationships state machine + chunked memory
description: Typed relationship edges between NPCs (stranger/friend/rival/dating/...) with named transitions. Subgoal-chunked memory so only the active schedule entry is in working context. Character bibles replace per-tick personality reconstruction.
status: todo
order: 255
epic: world
---

Depends on #225, #235, #245. By here the world has grounded actions, schedules, and objects — but NPCs don't remember each other or have differentiated bonds. This phase adds social state and a memory model that scales.

Research case (see `docs/research/tomodachi-life.md`, `docs/research/llm-agents-2025-2026.md` §1.3, §2):

- Tomodachi Life's relationship state machine (named transitions, not closeness scalars) is the most under-borrowed pattern in NPC design. Authoring dialogue against typed states is tractable; against a closeness float, it isn't.
- Park et al. 2024 (1,052-person sims) showed that grounding identity in a rich biography retrieved as one block beats prompt-only persona scaffolding by a wide margin.
- HiAgent (ACL 2025) shows subgoal-chunked working memory keeps context costs bounded — only the active subgoal is hot; finished chunks summarize and evict.
- Smallville-style memory streams are explicitly *not* the goal here — too expensive, too fragile under recursive reflection (see `docs/research/llm-agent-prior-work.md`).

## Deliverables

### Character bible

- One document per NPC: backstory, values, speech patterns, mannerisms, contradictions. Authored at character creation (or generated once from the persona pipeline).
- Stored as a single text blob on the manifest; included verbatim in every system prompt for that NPC. Replaces the current "persona summary" block.
- Length budget: ~500-1500 tokens. Long enough to feel specific; short enough to fit alongside perception.

### Relationship state machine

- Edges between every pair of NPCs that have interacted. Edge state is one of:
  - `stranger` (default, implicit) → `acquaintance` → `friend` → `close_friend`
  - parallel track: `acquaintance` → `rival` → `enemy`
  - parallel track: `friend` → `crush` → `dating` → `partner`
- Each transition has a named trigger (e.g. `friend → crush` requires N positive social interactions + a triggering event) and unlocks new dialogue/event-roll entries.
- Stored as a sparse adjacency table in SQLite. Most pairs are implicit-`stranger` and don't take a row.
- Transitions are server-validated through the GM; the LLM can *propose* a relationship change but the rules layer decides if it's allowed.

### Subgoal-chunked memory

- The active schedule slot (from #235) is the active subgoal. Its working memory — all observations, said-lines, used-objects during the slot — stays in the prompt as a single chunk.
- When the slot ends, the chunk is summarized into ~3-5 bullet points and stored as an episodic memory entry tagged `(subgoal-name, completion-state, partners)`.
- Retrieval is keyed on `(current subgoal, partners present)` — fetch the K most-relevant past chunk summaries. This is much cheaper than cosine similarity over thousands of unstructured memories.

### Relationship-aware perception

- The `buildUserTurn` perception text includes relationship state for every NPC currently visible: "You see Alice (close friend), Bob (rival)."
- Event-roll tables from #235 condition on relationship state — a `confession` event can only roll between NPCs whose edge is `crush`.
- Dialogue tags from the personality system include relationship axes.

### Memory inspector

- The inspector view gets a "memory" tab showing the NPC's character bible, active subgoal chunk, and the K most recent episodic chunk summaries.
- Useful for debugging "why did this NPC act surprised?" by checking what they actually remembered.

## Acceptance

- Two NPCs that have never met show as `stranger`; after a friendly conversation, the edge transitions through `acquaintance` and the next perception reflects it.
- A `rival` relationship visibly biases dialogue and event rolls vs. a `friend` relationship between the same personalities.
- An NPC's memory chunk for "this morning at the bakery" is summarized into bullets after the schedule slot ends; the chunk is retrievable by a later `(at-bakery, with-Alice)` perception.
- Per-NPC token cost stays bounded as the simulation runs — memory growth is sub-linear in time because chunks summarize and old summaries evict on retrieval misses.
- Character bibles are loaded once per turn (cached); regeneration is rare.

## Non-goals

- Reflection cascades (Smallville-style higher-order memory generation). Chunks summarize once; we do not summarize the summaries.
- Learned memory policies (Agentic Memory paper) — store/retrieve/update is rule-based here. Revisit if quality demands it.
- Family / kinship trees. NPCs have peer relationships only for now.
- Cross-character "common knowledge" (everyone knowing about a town event simultaneously). That's a phase-5 broadcast concern.

## Risk notes

- Authoring transition triggers is the hard part. Start with one or two transitions per edge and let event rolls do the heavy lifting; don't try to encode every social moment as a typed transition.
- Character bible drift: if generated, the bible can drift from the persona summary. Treat the bible as authoritative and regenerate the short summary from it, not the other way around.
- Memory summarization quality matters. Use a frontier model for summarization (rare, expensive call) even if turn-by-turn ticks use a SLM.

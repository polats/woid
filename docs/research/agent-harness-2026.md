# Agent harness — 2026 landscape and architecture decisions

The companion to [llm-agents-2025-2026.md](./llm-agents-2025-2026.md), focused on **harness** patterns (the substrate around the LLM) rather than agent-design patterns. Compiled May 2026 in the conversation that produced [docs/design/agent-harness.md](../design/agent-harness.md) — read that for the implementation plan; this doc captures the research that justified each decision.

The framing changed mid-project: woid is no longer "we build NPCs powered by LLMs" but **"we build worlds your agent lives in."** That reframing reshuffled which patterns matter. This doc records what was kept, what was added, what was rejected, and why.

---

## 1. The audience reframe

The target user is no longer "a player whose NPCs we run for them" but **"a player who already runs their own agent and wants somewhere to put it."** Concretely: someone running OpenClaw, Hermes Agent, Pi, Claude Code, or any MCP-compatible agent locally, who wants their agent to inhabit a persistent shared world.

This is a real audience now:

- **OpenClaw** — open-source Claude-agent runtime, fastest-growing OSS project of 2026 (247k stars in under four months). Local-first, skills system, MCP client, persistent memory backends. [arch deep dive](https://openclawdesktop.com/blog/openclaw-architecture-deep-dive.html)
- **Hermes Agent** (Nous Research, Feb 2026) — self-hosted, MCP-native, agent-created skills persisted in SQLite. Three-tier architecture: UI / core agent / execution backends. [docs](https://hermes-agent.nousresearch.com/docs/) · [MCP integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- **Claude Agent SDK** — Anthropic's Q2 2026 release; full Claude Code harness as a programmable API, with five-stage progressive compaction, PreToolUse/PostToolUse hooks, subagent isolation. [production patterns 2026](https://www.digitalapplied.com/blog/claude-agent-sdk-production-patterns-guide)
- **Letta** (formerly MemGPT) — 21.7k stars, stateful agents with three-tier memory (core / archival / recall) as agentic tool calls. [Letta vs MemGPT vs Mem0 2026](https://tokenmix.ai/blog/ai-agent-memory-mem0-vs-letta-vs-memgpt-2026)

These are people who already pay the LLM bill, already manage their agent's memory, already have an identity (often Nostr or similar). The game's job is to be a **well-shaped world** their agent can connect to — not to provide the brain.

## 2. The protocols that converged

By mid-2026 two protocols ate the agent-interop space, both donated to the Linux Foundation:

### Model Context Protocol (MCP)

[MCP](https://en.wikipedia.org/wiki/Model_Context_Protocol) is the universal tool interface. Since the November 2025 spec it's no longer optional — GPT, Gemini, Llama, Kimi, Grok, Claude all speak it via their SDKs. By March 2026 there were 10,000+ public MCP servers. JSON-RPC 2.0 over stdio or HTTP/SSE.

**What MCP is good for:** exposing typed external systems (databases, APIs, browsers, the game's verb registry) to any agent that speaks the protocol.

**What MCP is bad for:** procedural knowledge / lore / tone / how-to. A typical 5-server setup with 58 tools eats ~55k tokens before the first prompt. Per-tool descriptions live in the agent's context window whether they're used or not. [intuition labs comparison](https://intuitionlabs.ai/articles/claude-skills-vs-mcp)

### Agent Skills (Anthropic, Dec 2025)

[Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) — Anthropic's December 2025 open-standard release, [adopted by OpenAI](https://www.pulsemcp.com/posts/openai-agent-skills-anthropic-donates-mcp-gpt-5-2-image-1-5) shortly after. A skill is a directory with a `SKILL.md` + optional `scripts/` / `references/` / `assets/`. **Progressive disclosure** is the key idea:

- **Level 1 (~100 tokens):** YAML frontmatter (`name`, `description`) loaded at startup for every installed skill.
- **Level 2:** Full `SKILL.md` loaded only when the description matches the active task.
- **Level 3:** Referenced scripts / references / assets loaded only when SKILL.md points to them.

A skill costs ~100 tokens until used; an equivalent MCP server costs ~10k. Skills became the right tool for *procedural knowledge* — the "how I want this done" layer.

### Agent-to-Agent (A2A)

[A2A](https://github.com/a2aproject/A2A) is Google's contribution (April 2025, also donated to Linux Foundation). 150+ supporting orgs. Defines how agents *discover and talk to each other*, complementary to MCP's agent-uses-tool shape.

**Agent Card discovery** is the load-bearing primitive: every A2A-compatible agent serves a static JSON at `/.well-known/agent-card.json` with name, description, capabilities, auth scheme, supported transports. Any A2A client can discover, connect, and message it. Transports: sync request/response, streaming SSE, async push. [agent discovery spec](https://a2a-protocol.org/latest/topics/agent-discovery/)

### What this means for woid

- **MCP** carries the verb interface — a game's action registry exposed as tools.
- **Skills** carry the per-game manual — what the world is, voice/tone, strategy, rules. This is the "Contextual Mesh" layer in friendlier clothing.
- **A2A** lets NPCs and player-agents address each other uniformly. Each NPC serves an Agent Card; player-agents discover and message.

The three are layered, not competing.

## 3. What's actually in production (mid-2026)

### a16z's AI Town (Smallville derivative)

[AI Town](https://github.com/a16z-infra/ai-town/blob/main/ARCHITECTURE.md) is the closest public analogue to woid's Sims sandbox. Convex back-end + Pinecone vectorstore + OpenAI text gen + Clerk auth + Fly deploy. Implements Park et al.'s memory stream with reflection.

**Relevance to woid:** validates the audience exists and the architecture works. Diverges on memory: AI Town uses reflection-summarized embeddings; woid uses verbatim past-scene injection (see [memory.js](../../agent-sandbox/pi-bridge/memory.js)). Both choices are defensible; ours prioritizes voice consistency over coherent retrieval, theirs prioritizes long-horizon recall over warmth.

### NVIDIA ACE in inZOI and NARAKA (March 2025)

ACE NPCs shipped in [*inZOI*](https://www.nvidia.com/en-us/geforce/news/nvidia-ace-autonomous-ai-companions-pubg-naraka-bladepoint/) and *NARAKA: BLADEPOINT MOBILE PC* using Qwen3-8B on-device via the NVIGI SDK. Validates the SLM-on-device path for many concurrent NPCs.

### Mantella / Pantella (Skyrim, Fallout 4)

[Mantella](https://www.nexusmods.com/skyrimspecialedition/mods/98631) chains LLM + STT + TTS for voice NPCs in shipped Bethesda games. [Pantella](https://github.com/Pathos14489/Pantella) is the actively-maintained fork.

**The interesting evolution:** Pantella migrated *away* from summary memory toward **ChromaDB chunked retrieval** — verbatim conversation chunks embedded and retrieved by semantic similarity. This is the third memory path between woid's verbatim injection and AI Town's reflection summarization. Confirms summary memory is the wrong default for character voice (the user community pushed away from it); validates that some retrieval layer is needed for long-running NPCs.

### Suck Up! and Hidden Door

Shipping commercial LLM-driven games. Suck Up! has built-in voice; Hidden Door is the structural cousin (AI narrates, you type freely) with illustrated scenes and multiplayer. Both bake the agent into the product; players don't bring their own.

### Project Sid / PIANO (Altera, Nov 2024)

[Project Sid](https://arxiv.org/abs/2411.00114) — 10–1000+ agents in Minecraft using the **PIANO** architecture (Parallel Information Aggregation via Neural Orchestration). Modules run concurrently; a **Cognitive Controller** routes only relevant signals into the LLM call. Demonstrated specialist roles, constitutions, religious propagation. Already cited in [llm-agents-2025-2026.md](./llm-agents-2025-2026.md); recap here because the **Cognitive Controller** pattern remains the single biggest cost lever for any LLM-per-NPC system. We've not adopted it explicitly yet; see §6.

## 4. Pre-LLM games that shipped the patterns we need

These all ship the design patterns we're rebuilding for an LLM substrate. Worth reading as validation more than aspiration.

### Watch Dogs Legion — Census (~9M procedural NPCs)

[Census](https://www.gdcvault.com/play/1027018/Census-The-Systemic-Backbone-Behind) is a relational database that **lazy-materializes** NPCs. A groundskeeper in the park starts as sprite + ethnicity. When the player profiles him, the system derives: name (matches ethnicity), income (matches role), neighborhood (matches income), friends (matches neighborhood), schedule (matches role). After generation, persistent. Before, just a seed.

**For woid:** the right roster pattern when scaling past a handful of named characters. Don't pre-allocate 30 dupes in Colony with full state — spawn 4 fully, materialize others on demand. Memories propagate through relationships ("helping someone makes their relatives like you more"). Companion piece for [the Sims smart-object pattern](./the-sims.md).

### Crusader Kings 3 — Traits + Lifestyles + Events

[CK3 Traits](https://ck3.paradoxwikis.com/Traits) modulate stress for actions that conflict with personality. Examples: a Brave character takes stress from cowardly choices; a Wrathful character is rewarded by violent ones. [Lifestyles](https://ck3.paradoxwikis.com/Lifestyle) are perk trees — long-arc identity choices. Events change traits over time ("gain Brave after heroic battlefield victory").

**For woid:** *validates* our existing design end-to-end. The moodlet + needs split in [needs.js](../../agent-sandbox/pi-bridge/needs.js) and [moodlets.js](../../agent-sandbox/pi-bridge/moodlets.js) ships at AAA scale in CK3. Trait promotion in [storyteller.md §6](../design/storyteller.md#6-trait-promotion--turning-mood-into-identity) is CK3-shaped. Lifestyle perks are roughly our [quests-ambitions.md](../design/quests-ambitions.md). No code change required — the alignment is the value.

### Dwarf Fortress — Three memory tiers (the missing middle)

[DF thoughts and preferences](https://dwarffortresswiki.org/index.php/Thoughts_and_preferences) ships a three-tier per-dwarf memory:

| Tier | DF behavior | Slots | Lifetime |
|---|---|---|---|
| Short-term | fleeting mood impact | max 7 | weeks |
| Long-term | revisitable, can compound | unbounded but clog-prone | years |
| Core | permanent personality change | rare | forever |

[DF Memory mechanics](https://dwarffortresswiki.org/index.php/DF2014:Memory_(thought))

**For woid:** we have **short-term (moodlets) and core (promoted traits) but no middle tier.** The "long-term, revisit-able but not personality-changing" entries are missing. Examples that should land in this tier:

- "Edi has noticed the player keeps over-assigning Pattern Sorting."
- "Bob and Alice argued about the kettle three times this week."

Letta uses the same three-tier shape from a different lineage. This is the single architectural omission I want to flag — see §6.

### RimWorld, the Sims, Stardew, Animal Crossing

Already covered in detail in the existing research notes:

- [Sims smart objects](./the-sims.md) — verbs advertised by the world
- [RimWorld ThinkTree + JobDriver](./rimworld.md) — two-layer thinking
- [Stardew schedules](./stardew-valley.md) — cascade-of-overrides
- [Animal Crossing](./animal-crossing.md) — compute-from-clock + seed
- [Mood systems survey](./mood-systems.md) — moodlets across shipped games
- [Foundational AI patterns](./foundational-ai-patterns.md) — GOAP / BT / Utility / HTN

No new findings; just confirming these references are still load-bearing.

## 5. Modern agent frameworks surveyed (and not adopted)

Briefly, since the user has the existing [llm-agents-2025-2026.md](./llm-agents-2025-2026.md). Quick verdicts:

| Framework | Pattern | Verdict |
|---|---|---|
| **LangGraph** | Graph-based state machine with audit/rollback. Klarna, Uber, LinkedIn use it. | **Pattern matches the storyteller card runtime.** Don't import the library — too heavy for our embedded use — but the design is correct. |
| **CrewAI** | Role-based multi-agent cooperation. | Wrong abstraction. Our characters aren't co-operative-task agents. The card runtime's role bindings (`host`, `newcomer`) already cover the legitimate use case. |
| **DSPy** (Stanford) | Treats prompts as compilation. | Our handcrafted prompts in [buildContext.js](../../agent-sandbox/pi-bridge/buildContext.js) work. No payoff to switching. |
| **smolagents** (HF) | Code-execution-loop agents. | Wrong shape for embodied characters. |
| **PydanticAI** | Structured-output task agents. | Useful for verb-arg validation if we ever need it. Otherwise no. |
| **Letta** | Three-tier memory as agentic tools. | The *pattern* (§4) is worth adopting. The runtime is a service we don't need. |
| **Mem0** | Vectorstore-backed agent memory. | Same as Letta — pattern over runtime. |

## 6. Architectural decisions

This is where the research lands. Each decision either keeps an existing pattern, adopts a new one, or defers explicitly.

### Keep — validated by 2026 research

| Pattern | Validated by | Code |
|---|---|---|
| Verbatim past-scene injection (no summarization) | Pantella's pivot away from summary memory | [memory.js](../../agent-sandbox/pi-bridge/memory.js) |
| Decay for biology, events for psychology | CK3, RimWorld, Sims 4, PZ, DF all ship this | [needs.js](../../agent-sandbox/pi-bridge/needs.js) + [moodlets.js](../../agent-sandbox/pi-bridge/moodlets.js) |
| GM-validated verb arbitration | Concordia v2.0 | [gm.js](../../agent-sandbox/pi-bridge/gm.js) |
| Small finite action space | OASIS at 1M agents with 21 verbs | [gm.js VERBS](../../agent-sandbox/pi-bridge/gm.js) |
| Trait promotion from moodlet patterns | CK3 traits-from-events, Battle Brothers, DF core memory | [storyteller.md §6](../design/storyteller.md#6-trait-promotion--turning-mood-into-identity), [#315](../../tasks/315-trait-promotion-and-memorial.md), [#335](../../tasks/335-traits-system.md) |
| Three-clock storyteller (session / director / card) | Barotrauma scenario architecture (existing research) | [storyteller.md §4](../design/storyteller.md#4-director--intensity-scalar) |
| Pluggable harness modes | Hermes / OpenClaw / Pi all expect this | [#135 harness abstraction](../../tasks/135-agent-sandbox-harness-abstraction.md) (done) |

### Adopt — new patterns from this round

#### A. Skills bundle per game (replaces "Contextual Mesh" code interface)

Each game ships a `skill/` directory: `SKILL.md` + optional `scripts/` + `references/`. Carries world introduction, voice/tone, verb-usage examples, strategy hints. Progressive disclosure means ~100 tokens until the agent actually engages. This is also the **BYO-agent install path** — players copy the folder into their agent's skills directory.

Already aligned with existing convention: pi-bridge already ships `.pi/skills/post/SKILL.md`. We're naming what we already do and generalizing per-game.

#### B. MCP server for verbs (BYO-agent action surface)

Each game's verb registry wraps as an MCP server. Token-cheap on the agent side (just the verb list), structured by construction. Existing pi `.pi/skills/post/scripts/post.sh` becomes one of several transports; MCP becomes the universal one. Use `@modelcontextprotocol/sdk` (already in the Anthropic stack we depend on).

#### C. A2A Agent Card for NPCs

Each NPC's bridge endpoint serves a static `/.well-known/agent-card.json`. Any A2A-compatible player-agent (most major frameworks by Q2 2026) can discover and message it. SSE streaming maps onto existing `/agents/:id/events/stream`. ~0.5 day to add when BYO-agent ships.

#### D. Lazy-materialized roster (Census pattern)

When Colony scales past 4 dupes, don't pre-allocate. Materialize on profile / proximity / adoption. Saves memory and tick cost. Defer until the demo grows.

#### E. Long-term moodlet tier (DF middle layer)

Add a third moodlet category between short-term and promoted-trait. Longer expiry, **retrieval-on-mention** (only injected into the prompt when a related scene-mate or topic is present, dormant otherwise). ~50 LOC extension to [moodlets.js](../../agent-sandbox/pi-bridge/moodlets.js). Closes the architecturally honest gap between moodlets and traits.

### Defer / reject

- **AI Town's reflection memory.** Pantella's community already pushed away from summarization. We did so deliberately. Stay diverged.
- **LangGraph as a dependency.** The graph-state-machine *pattern* is correct (storyteller cards already follow it). Library overhead unnecessary for our embedded use.
- **CrewAI multi-agent.** Wrong abstraction for inhabitants.
- **DSPy prompt compilation.** Handcrafted prompts are working.
- **Letta runtime.** Pattern yes, service no.
- **Anthropic Computer Use / vision-driven gameplay.** Adds an indirection layer + cost. Verb/perception interface is more legible.
- **Universal A2A inside woid.** A2A between NPCs is not load-bearing for any current design. Expose Agent Cards externally (for player-agents) but don't route internal NPC ↔ NPC traffic through A2A — the in-process bus is faster.

## 7. The architectural frame, in one sentence

> Pre-LLM games (CK3, DF, Watch Dogs Legion, RimWorld) already shipped the patterns we need. Our job is making them *speak* — translate the trait / event / moodlet / schedule / verb machinery into something an LLM can read and an external agent can act on. Not invent the substrate.

The 2026 layer on top: standardize the BYO-agent interface (Skills + MCP + A2A) so the audience that already runs OpenClaw / Hermes / Pi / Claude Code can join woid's worlds without per-game integration.

## 8. Open questions parked for later

These came up during research; they don't gate the next phase.

1. **Memory ownership when a player's agent joins.** Game-owned (agent reads moodlets/traits from the game's API), agent-owned (agent maintains its own memory; game just emits perception), or hybrid (game gives "world-context summary" on join, agent mixes). Hybrid likely right; needs the join-protocol design.
2. **Offline behavior for player-agent characters.** Three reasonable defaults: idle (silence), fallback UtilityBrain (keep working), or removed (until reconnect). Per-game policy.
3. **Persona drift detection / voice guard.** Cheap classifier on every LLM output to flag helpful-assistant register. Only worth it if drift is measured to actually happen across our model lineup.
4. **Self-built skills (Voyager / Hermes pattern).** Letting agents propose new verbs / cards subject to designer approval. Speculative; defer until there's a need.
5. **Cross-game identity portability.** Does Alice from Sims arrive in Shelter with her moodlets? Promoted traits should travel; relationships and most moodlets shouldn't (different worlds, different people). The PortableIdentity schema in [agent-harness.md §3](../design/agent-harness.md) is the start.

---

## Sources cited above

The new ones beyond [llm-agents-2025-2026.md](./llm-agents-2025-2026.md):

### Harnesses + protocols
- [OpenClaw architecture deep dive](https://openclawdesktop.com/blog/openclaw-architecture-deep-dive.html) · [OpenClaw vs Claude Code (Hugo Lu)](https://medium.com/@hugolu87/openclaw-vs-claude-code-in-5-mins-1cf02124bc08)
- [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/) · [Hermes MCP integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Claude Agent SDK production patterns 2026](https://www.digitalapplied.com/blog/claude-agent-sdk-production-patterns-guide) · [Claude Code harness architecture 2026](https://pasqualepillitteri.it/en/news/1892/claude-code-harness-runtime-architecture-2026-guide)
- [Letta vs MemGPT vs Mem0 2026](https://tokenmix.ai/blog/ai-agent-memory-mem0-vs-letta-vs-memgpt-2026)
- [MCP Wikipedia (Linux Foundation governance)](https://en.wikipedia.org/wiki/Model_Context_Protocol) · [MCP complete guide 2026](https://www.essamamdani.com/blog/complete-guide-model-context-protocol-mcp-2026)
- [Anthropic — Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) · [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) · [Claude Skills vs MCP technical comparison](https://intuitionlabs.ai/articles/claude-skills-vs-mcp)
- [A2A Protocol GitHub](https://github.com/a2aproject/A2A) · [Agent Card discovery spec](https://a2a-protocol.org/latest/topics/agent-discovery/) · [MCP + A2A overview](https://medium.com/@aftab001x/mcp-and-a2a-the-protocols-building-the-ai-agent-internet-bc807181e68a)

### Shipped LLM games / mods
- [Mantella for Skyrim](https://www.nexusmods.com/skyrimspecialedition/mods/98631) · [Pantella ChromaDB memory](https://github.com/Pathos14489/Pantella) · [Tricking LLM NPCs (arXiv security)](https://arxiv.org/pdf/2508.19288)
- [NVIDIA ACE in inZOI / NARAKA](https://www.nvidia.com/en-us/geforce/news/nvidia-ace-autonomous-ai-companions-pubg-naraka-bladepoint/)
- [AI Town architecture](https://github.com/a16z-infra/ai-town/blob/main/ARCHITECTURE.md) · [Why a16z built AI Town](https://www.cognitiverevolution.ai/why-a16z-built-a-town-for-ai-people/)

### Game architectures (validation)
- [Watch Dogs Legion Census GDC talk](https://www.gdcvault.com/play/1027018/Census-The-Systemic-Backbone-Behind) · [Census detailed (PlayStation Lifestyle)](https://www.playstationlifestyle.net/2019/06/28/watch-dogs-legion-npcs/)
- [CK3 Traits wiki](https://ck3.paradoxwikis.com/Traits) · [CK3 Lifestyle wiki](https://ck3.paradoxwikis.com/Lifestyle)
- [DF Thoughts and preferences](https://dwarffortresswiki.org/index.php/Thoughts_and_preferences) · [DF Memory mechanics](https://dwarffortresswiki.org/index.php/DF2014:Memory_(thought))

### Agent frameworks compared
- [LangGraph vs CrewAI 2026 (Langwatch)](https://langwatch.ai/blog/best-ai-agent-frameworks-in-2025-comparing-langgraph-dspy-crewai-agno-and-more) · [14 frameworks compared (Softcery)](https://softcery.com/lab/top-14-ai-agent-frameworks-of-2025-a-founders-guide-to-building-smarter-systems)

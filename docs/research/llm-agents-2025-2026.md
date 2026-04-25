# LLM agent simulation — 2025/2026 update

A breadth-first survey of post-Smallville / post-AI-Town work relevant to a many-NPC, map-based, schedule-following sandbox. Compiled 2026-04-25. Companion to [llm-agent-prior-work.md](llm-agent-prior-work.md), which covers the 2023 originals.

---

## 1. Direct successors to Generative Agents / AI Town

### Project Sid + PIANO architecture (Altera, Nov 2024)

[arXiv](https://arxiv.org/abs/2411.00114) · [GitHub](https://github.com/altera-al/project-sid) · [Blog](https://fundamentalresearchlabs.com/blog/project-sid)

Introduces **PIANO** (Parallel Information Aggregation via Neural Orchestration). Instead of a serial memory→reflect→plan loop, agents run ~10 modules concurrently (cognition, planning, motor, speech, social awareness, goal generation, memory) at different time scales. A **Cognitive Controller** is the bottleneck that routes only the relevant signals into the LLM call so outputs stay coherent. Demonstrated up to 1,000 agents in Minecraft self-organizing into specialist roles, voting on a constitution via Google Docs, and propagating Pastafarianism by bribery.

**For woid:** the most directly applicable architectural alternative to "every tick ask the big LLM what the agent does next." Cheap modules can run on every tick (movement, perception); expensive LLM calls happen only when the controller decides a decision is needed. Their own scaling admission: 1,000-agent runs *exceeded the Minecraft server's compute*, not the LLM budget. The world tick is the real bottleneck.

### AgentSociety (Tsinghua FIB Lab, Feb 2025)

[arXiv](https://arxiv.org/abs/2502.08691) · [GitHub](https://github.com/tsinghua-fib-lab/AgentSociety)

10,000+ agents and ~5M interactions in a realistic city environment. Agents have internal "minds": emotions, needs, motivations, cognition. Behaviors (mobility, employment, consumption, social) are driven by these states rather than by raw memory retrieval.

**For woid:** closest analogue to "many NPCs with schedules in a shared world." Their behavior-from-needs design is a lighter alternative to memory streams — a need vector ticks deterministically and only triggers an LLM when a threshold is crossed.

### Stanford follow-up: 1,052-person agent simulations (Park et al., Nov 2024)

[arXiv](https://arxiv.org/abs/2411.10109) · [Stanford HAI](https://hai.stanford.edu/news/ai-agents-simulate-1052-individuals-personalities-with-impressive-accuracy)

Joon Park's direct follow-up to Smallville. Builds person-specific agents from 2-hour qualitative interviews + surveys. Reaches 85% of participants' own test-retest consistency on General Social Survey items.

**For woid:** validates that grounding identity in rich biography outperforms prompt-only persona scaffolding. Argues for a "character bible" object per NPC (long, rich biography retrieved as a single context) over a memory stream that has to discover personality from logs.

### Concordia v2.0 (Google DeepMind, 2024–2025)

[GitHub](https://github.com/google-deepmind/concordia) · [v2.0 announcement](https://www.cooperativeai.com/post/google-deepmind-releases-concordia-library-v2-0) · [Reliability paper](https://arxiv.org/abs/2411.07038)

TTRPG-inspired. A **Game Master** entity simulates the world; player entities act through a flexible component system mediating LLM calls and associative memory. v2.0 made the engine lighter — clocks optional, GMs are just entities, "prefabs" replace "factories."

**For woid:** the Game Master pattern is a clean answer to "who arbitrates whether an agent's emitted action is grounded?" Instead of letting each agent freely mutate world state, all proposed actions go through a GM who validates against world rules.

---

## 2. Architectural alternatives to memory-stream + reflection

### OASIS — million-agent social simulation (CAMEL, Dec 2024)

[arXiv](https://arxiv.org/abs/2411.11581) · [GitHub](https://github.com/camel-ai/oasis)

Targets social-media dynamics (X, Reddit) at 1M agents. **21-action API.** Replicates information spread, group polarization, herd effects.

**For woid:** demonstrates you can scale to 10⁶ by aggressively narrowing the action space. Define a small finite verb set per location/object class.

### HiAgent — hierarchical working memory (ACL 2025)

[Paper](https://aclanthology.org/2025.acl-long.1575/)

Uses **subgoals as memory chunks**; agent formulates a subgoal, then only the relevant chunk is in working memory while it executes. When the subgoal is done, the chunk is summarized and evicted.

**For woid:** schedule entries ("go to the bakery at 09:00") naturally form subgoal frames — keep only the active one hot.

### ReflAct — world-grounded decision making (EMNLP 2025)

[Paper](https://aclanthology.org/2025.emnlp-main.1697/) · [arXiv](https://arxiv.org/html/2505.15182v2)

Replaces ReAct's "think, act" with "reflect on goal vs. state, then act." Forces the agent to re-anchor to its goal each step. +27.7% over ReAct, 93.3% on ALFWorld.

**For woid:** cheap drop-in upgrade to per-tick prompting that addresses schedule drift. Each LLM call becomes "Given my current goal X and current state Y, what's the next grounded action?"

### Agentic Memory and "Hindsight is 20/20"

[Hindsight 20/20](https://arxiv.org/html/2512.12818v1) · [Agentic Memory](https://arxiv.org/html/2601.01885v1)

Two strands of work past the importance-scored memory stream: preference-conditioned retrieval (Hindsight) lifts long-context benchmarks from 39% to 83.6%; agentic memory makes store/retrieve/update/discard a *learned action* rather than a fixed scoring rule.

**For woid:** implementable as tool calls (`remember()`, `forget()`, `summarize()`) on top of any frontier LLM with no fine-tuning.

### CoALA (still the canonical reference)

[arXiv](https://arxiv.org/abs/2309.02427)

Working memory + episodic / semantic / procedural long-term memory; structured action space (retrieval, reasoning, learning, grounding). Useful taxonomy for naming components rather than a thing to implement directly.

---

## 3. Game / interactive demos shipped in 2025

### NVIDIA ACE Autonomous Game Characters

[Announcement](https://www.nvidia.com/en-us/geforce/news/nvidia-ace-autonomous-ai-companions-pubg-naraka-bladepoint/) · [Qwen3 SLM blog](https://developer.nvidia.com/blog/nvidia-ace-adds-open-source-qwen3-slm-for-on-device-deployment-in-pc-games/)

ACE NPCs shipped in *inZOI* (Mar 28, 2025) and *NARAKA: BLADEPOINT MOBILE PC*. Uses **Qwen3-8B SLM on-device** via the NVIGI SDK; runs locally on RTX hardware.

**For woid:** validates the SLM-on-device path for many concurrent NPCs at frame-rate-friendly latencies. Qwen3-8B is a realistic target for the per-NPC inner loop with a frontier model used only for hard decisions.

### Inworld AI Runtime (GDC 2025)

[Blog](https://inworld.ai/blog/gdc-2025)

A C++ graph engine (Node.js / Unreal SDKs) orchestrating LLM, STT, TTS, memory, tools in a single pipeline. Character Brain / Contextual Mesh / Real-Time AI layer split.

**For woid:** the graph-engine-of-modules pattern is what production studios are converging on — same shape as PIANO. Separate the per-NPC module graph from the world tick loop.

### Convai (Unreal/Unity SDKs, 2025)

[Blog](https://convai.com/blog/integrating-dynamic-npc-actions-for-game-development-with-convai)

Dynamic NPC actions via LLM function calls; multimodal perception (NPCs see/hear surroundings). Their action API design — a constrained set of in-world verbs each NPC can call — is exactly the "grounded action" pattern woid needs.

### Roblox Cube + AI Studio 4D (late 2025)

[Coverage](https://www.financialcontent.com/article/tokenring-2025-12-25-beyond-the-third-dimension-roblox-redefines-metaverse-creation-with-4d-generative-ai-and-open-source-cube-model)

Open-source "Cube" model. Generates NPCs *with behavior and physics* (not just art) inside Roblox Studio. First mass-market platform shipping generative NPCs at real scale.

### Genie 3 (Google DeepMind, Aug 2025)

[Blog](https://deepmind.google/blog/genie-3-a-new-frontier-for-world-models/)

Real-time 24fps 720p interactive world model. Persistent state for ~1 minute.

**For woid:** cautionary / inspirational. World models could eventually replace a hand-built map. For now, 1-minute consistency horizon means it's not a substitute for an authoritative simulation server.

### Indie / open demos worth tracking

- [EmemeTown](https://store.steampowered.com/app/2667830/EmemeTown/) — AI-NPC life sim with personality config, schedules, 1000+ animation library.
- [NPC-Playground (Cubzh + Gigax)](https://huggingface.co/blog/npc-gigax-cubzh) — open 3D playground, teach NPCs new skills via Lua.
- *Whispers from the Star* (Anuttacon) — released title with AI-driven dialog NPCs.

---

## 4. Evaluation / benchmarks

- **SOTOPIA family** — social intelligence: [LIFELONG-SOTOPIA](https://arxiv.org/abs/2506.12666) (multi-episode lifetime tasks), [SOTOPIA-RL](https://arxiv.org/html/2508.03905v1) (utterance-level rewards), [SOTOPIA-S4](https://www.cs.cmu.edu/~sherryw/assets/pubs/2025-sotopia-s4.pdf) (parallel customizable simulations). Closest existing analogue to a "believable NPC" benchmark.
- **AgentBench** ([arXiv](https://arxiv.org/abs/2308.03688)) and **AgentGym** ([ACL 2025](https://aclanthology.org/2025.acl-long.1355.pdf)) — task-completion benchmarks across many environments. Better for "is your agent good at tools" than "is your NPC believable."
- **AMA-Bench** ([arXiv](https://arxiv.org/html/2602.22769v1)) — multi-day human dialogues. Most relevant external evaluation for testing whether woid NPCs remember each other across a simulated week.
- **OdysseyBench** ([arXiv](https://arxiv.org/pdf/2508.09124)) — long-horizon office-app tasks.

---

## 5. What didn't work — failure modes from 2025

### "Why Do Multi-Agent LLM Systems Fail?" (Cemri et al., NeurIPS 2025)

[arXiv](https://arxiv.org/abs/2503.13657)

41–86.7% failure rates across 7 popular MAS frameworks on real tasks. Introduces **MAST** taxonomy: 14 failure modes in 3 clusters — system design, inter-agent misalignment, task verification. Crucial finding: **single-agent setups using the same model often outperform the multi-agent version.** Multi-agency itself is the bug.

**For woid:** don't add agents-talking-to-agents until you've measured that it actually helps. The "Coordination Tax" saturates around 4 agents in a single decision loop.

### The 17× error trap

[Towards Data Science](https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/)

At 15% per-call failure across a 30-call chain, P(at least one failure) > 99%. Per-tick LLM calls per NPC are a chain. Either drive the per-call error rate way down (cheap deterministic modules where possible) or break the chain (don't call LLM unless something changed).

---

## 6. Cost-efficient routing patterns

- **Hybrid LLM/SLM routing** ([ICLR 2024](https://openreview.net/forum?id=02f3mUtqnM)) — difficulty router sends easy queries to a small on-device model, hard ones to a frontier model. ~40% fewer big-model calls with no quality loss.
- **MixLLM** ([NAACL 2025](https://aclanthology.org/2025.naacl-long.545.pdf)) — routes based on learned predictions of per-model success per query type.

The right shape for woid: a per-NPC SLM (Qwen3-8B / Llama-3-8B class) doing 95% of decisions, escalating to a frontier model only when a "novelty" or "social conflict" classifier fires.

---

## 7. Voyager lineage (lifelong embodied agents)

### MindForge (NeurIPS 2024)

[OpenReview](https://openreview.net/forum?id=u7jtLj46i9)

Voyager + theory-of-mind + cultural transmission between agents. With open-weight LLMs, 3× more tech-tree milestones than Voyager baseline.

**For woid:** skill-library-as-code (Voyager's pattern) transferred between NPCs by *teaching* is a clean way for NPCs to develop differentiated specializations over time without retraining.

---

## 8. Net assessment for woid

1. **The "every tick → big LLM" pattern is dead.** Both Sid (PIANO) and Inworld converge on graph-of-modules + Cognitive Controller, where LLM calls are gated by cheap classifiers.
2. **Game Master arbitration (Concordia) > free-form world mutation.** Route every proposed NPC action through a deterministic validator.
3. **Schedule coherence is solved by subgoal-as-memory-chunk (HiAgent).** Active schedule entry stays hot; the rest is summarized and cold.
4. **Frontier-model-per-NPC does not scale; SLM-per-NPC + occasional escalation does.** Qwen3-8B on-device is the proven default.
5. **Action space must be small and finite.** OASIS hit 1M agents with 21 verbs. Open-ended actions cost orders of magnitude more.
6. **Multi-agent ≠ better.** Single-agent often beats MAS on the same model. Add agent-to-agent communication only where you can measure a lift.
7. **Persona from rich biography (Park 2024) outperforms persona from prompt.** Give each NPC a detailed character document, not a one-liner.
8. **Use SOTOPIA / LIFELONG-SOTOPIA + AMA-Bench for evaluation.** No canonical "believable NPC" benchmark yet, but these are the closest off-the-shelf harnesses.

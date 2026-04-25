# LLM-era prior work — Generative Agents and AI Town

Two reference projects that experimented with LLMs as NPC brains. Both validated *that* it can work; neither validated *how to do it well at scale*. Treated here primarily as cautionary references — they made architectural choices we should learn from but not necessarily copy.

---

## Generative Agents: Interactive Simulacra of Human Behavior

Park et al., 2023. The Stanford "Smallville" paper. [Paper PDF](https://arxiv.org/abs/2304.03442). [Project page](https://reverie.herokuapp.com/arXiv_Demo/).

### What they built

A 25-agent town simulation where each agent had:

- **Memory stream** — append-only natural-language log of every observation, action, reflection
- **Importance score** — each memory rated 1–10 by the LLM
- **Retrieval** — combination of recency + importance + similarity (cosine on embeddings)
- **Reflection** — periodically, the agent generates higher-order memories from clusters of recent memories ("I noticed I keep going to the cafe; I must enjoy social settings")
- **Plans** — daily plan generated each morning, decomposed hour-by-hour, then minute-by-minute as needed

### Key architectural decisions

- **All memories are natural language, not structured.** Even "I am at the cafe" is stored as a sentence.
- **Retrieval is the bottleneck.** Each turn retrieves a top-K of relevant memories from the (growing) stream and stuffs them into the prompt.
- **Reflection is a recursive process.** Reflections are themselves stored as memories and can trigger further reflections.
- **The world is structured (map, objects, rooms) but the agent's perception is text.** Each tick, the world produces a string description of what the agent perceives.

### What worked

- **Believable individual behavior.** Agents would remember meeting each other and reference prior conversations.
- **Emergent social events.** The classic "Valentine's Day party" emergence — agents organically planned and attended a party without it being scripted.

### What didn't

- **Cost.** Tens of LLM calls per agent per simulated hour. Smallville's 25 agents over a 2-day sim was ~$10,000 of GPT-3.5 calls.
- **Memory retrieval gets slower as the stream grows.** The cosine similarity over thousands of embeddings is non-trivial.
- **Reflection quality decays.** Recursive reflection eventually produces vague, generic insights ("People seem to enjoy talking to each other") that crowd out useful concrete memory.
- **No grounded action validation.** Agents would describe doing things they couldn't physically do, and the system would accept it.

### Lessons for woid

- **Don't mimic the memory stream architecture wholesale.** It's expensive and the reflection cascade is fragile. Prefer structured state (mood, relationships, schedule) augmented with selective unstructured memory, not the other way around.
- **Their "world produces text perception" pattern is sound** — and matches our `buildUserTurn` shape. They proved the LLM can act on textual perception alone.
- **Cost is the architectural concern, not novelty.** Any pattern that scales calls per agent per minute will not run at hundreds of agents.

---

## AI Town

a16z-infra / convex-dev open-source project. [GitHub](https://github.com/a16z-infra/ai-town).

### What they built

A real-time multiplayer browser-based town with LLM NPCs. Tilemap world with named characters; each NPC has a position, an inventory, and a Convex DB record holding their memory and current activity.

Built on **Convex** (a serverless reactive database) — every state change runs server functions reactively. Effectively replaces a tick loop with a stream of database mutations.

### Architecture

- World as a tilemap with collision and POIs
- Each NPC as a Convex document
- Per-agent function `agentDoSomething` runs every few seconds when the agent is "active"
- Conversations between two agents are mediated by Convex transactions — one starts, the other accepts, turns alternate
- Pathfinding is server-side, results cached
- LLM provider pluggable (OpenAI, replicate-hosted)

### What worked

- **Real multiplayer.** Multiple NPCs visible in the same browser at the same time, walking around, having conversations.
- **Convex's reactivity replaces a tick loop.** Each state change reactively triggers downstream functions; no polling.
- **Open source and extensible.** Many forks built different worlds on the foundation.

### What didn't

- **Conversation initiation is brittle.** Two NPCs needing to "agree" to talk via DB transactions led to lots of half-started conversations and stuck states.
- **Same cost problem as Smallville.** Active agents make calls every few seconds; the bill grows linearly with agent count × wall-clock time.
- **No obvious story emerges.** Without authored arcs, NPCs settle into wandering and small-talk loops.

### Lessons for woid

- **Reactive databases are an interesting alternative to tick loops.** Convex pushed every mutation through server functions. Our scheduler could plausibly be reactive (write to a `pendingTrigger` table, downstream functions fire) rather than polling — but adds infrastructure complexity.
- **Conversation as transaction is probably the wrong abstraction.** NPCs shouldn't need to "agree to talk" before exchanging messages. The room-broadcast-with-anti-silence-rule we already have handles this better.
- **Multiplayer-from-day-one is a feature.** AI Town's strongest demo is "multiple humans dropping in to watch the same world." We have this property naturally via the Colyseus layer.

---

## Net assessment

These projects validated:

- LLM-as-NPC-brain produces believable individual behavior in small worlds
- Textual perception is enough for the LLM to act sensibly
- Multiplayer/observation works fine

They did *not* validate:

- Cost-effective scale
- Long-running emergent narrative beyond party-style events
- Grounded action (LLM-emitted actions reliably executed by the world)

The traditional game references in the rest of this folder address exactly the gaps these projects left open: LOD for cost, scheduled backbones for narrative, deterministic execution layers for grounding.

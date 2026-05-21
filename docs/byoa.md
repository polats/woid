# Bring your own agent

The audience this is for: you already run an agent locally — OpenClaw, Hermes Agent, Pi, Claude Code, or any MCP-compatible runtime. You want a world your agent can live in.

woid is building toward exactly that. This doc tracks where we are.

See also: [docs/design/agent-harness.md](design/agent-harness.md) (plan), [docs/research/agent-harness-2026.md](research/agent-harness-2026.md) (research).

## Status

| Layer | Ships? | Where |
|---|---|---|
| Cross-game agent harness | **yes** | [`src/lib/harness/`](../src/lib/harness/) — perception, needs, moodlets, memory, Brain/Verb/GameAdapter interfaces |
| Reference game (Colony) running on the harness | **yes** | [`src/lib/colony/`](../src/lib/colony/) — `#/colony` in the woid UI |
| Skill bundle convention (Anthropic Agent Skills format) | **yes** | [`src/lib/colony/skill/`](../src/lib/colony/skill/) — `SKILL.md` + scripts + references |
| Colony HTTP API (`/colony/join`, `/colony/verb`, `/colony/perception` SSE) | **no (deferred)** | Phase 4b in the agent-harness plan §7 |
| MCP server wrapping Colony verbs | **no (deferred)** | Plan §7; ships when broader agent reach (web-only chatbots, hosted platforms) matters |
| A2A Agent Card per NPC | **no (deferred)** | Plan §7 |
| Memory ownership / offline-behavior protocol | open question | Research §8 |

What this means today: the **convention** is shipped. The wire transport that lets an external agent actually drive a dupe is the next milestone.

## How to read the skill bundle right now

The skill bundle at [`src/lib/colony/skill/`](../src/lib/colony/skill/) is the canonical example of how an external game world surfaces itself to a BYO-agent. Today its purpose is:

1. **Documentation** — `SKILL.md` describes Colony's verbs, needs, strategy, and voice in the Anthropic Agent Skills format. Read it the same way OpenClaw / Hermes load any skill.
2. **Template** — copy `src/lib/colony/skill/` into `src/lib/<yourgame>/skill/` for your own game. Replace SKILL.md's body; update the verb list; keep the format.
3. **Forward-compatible stubs** — `scripts/take_job.sh` documents the future HTTP API shape so when the server ships, only the script bodies change.

## Roadmap

When Phase 4b ships:

```
1. Run the woid bridge:
   $ npm run agent-sandbox:up

2. Generate a Nostr key for your agent:
   $ nak key > ~/.woid/colony-key

3. Copy the skill bundle into your agent's skills dir:
   $ cp -r woid/src/lib/colony/skill ~/.openclaw/skills/colony/
   # or wherever Hermes / Pi / Claude Code looks for skills

4. Start your agent. Tell it: "play Colony for an hour."
   The agent reads SKILL.md, joins the world via POST /colony/join,
   subscribes to /colony/perception via SSE, and starts emitting
   verbs via POST /colony/verb.
```

Until that's wired, the demo path is: open `#/colony` in the woid UI and watch the built-in utility-AI dupes work autonomously. No LLM cost, no external agent — Colony is a working game today; the BYO-agent layer is the bring-your-own seam.

## Why deferred

The plan's §7 enumerates deferred hooks with explicit activation triggers. The BYO-agent HTTP API's trigger is: **after Phase 0–3 ships and someone (you, an external adopter) signals they want to drive a dupe.** Shipping the server speculatively before someone wants to use it has been the costliest move in prior projects. We did not make it again.

## Open questions

Same as in the research note §8:

1. **Memory ownership.** When your agent joins, is your existing memory authoritative, is the game's, or some hybrid? Probably hybrid; protocol TBD.
2. **Offline behavior.** When your agent disconnects, does your dupe go idle, run the fallback `UtilityBrain`, or get removed? Probably configurable.
3. **Cross-game identity portability.** Should a `PortableIdentity` you build up in Sims travel to Colony? Traits yes; relationships and most moodlets probably no.

If you're using woid and want any of these resolved sooner, open an issue or drop into the woid project — the answers will be driven by the first real BYO-agent player, not by us guessing in the abstract.

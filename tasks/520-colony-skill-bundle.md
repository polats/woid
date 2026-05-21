---
name: Colony — BYO-agent skill bundle (SKILL.md + bash scripts + auth)
description: Ship a Colony skill bundle that OpenClaw / Hermes / Claude Code players can install to make their own agent play Colony. Just files — SKILL.md, bash scripts hitting the existing HTTP API, signed Nostr auth. No new protocol, no MCP server in this card.
status: done
order: 520
epic: harness
depends_on: [470, 480, 490, 500, 510]
---

Phase 4 (optional) of the agent harness plan. See **[docs/design/agent-harness.md §6 / Phase 4](../docs/design/agent-harness.md#phase-4--colony-skill-bundle-optional-520)** for full plan context. The research that named the Skills pattern is in [docs/research/agent-harness-2026.md §2](../docs/research/agent-harness-2026.md#agent-skills-anthropic-dec-2025).

This is the **BYO-agent install path** — the proof that a player who already runs OpenClaw, Hermes Agent, or Claude Code can drop a skill bundle into their agent's skills directory and inhabit a Colony dupe.

The card is deliberately small (≤1 day) because **Skills are just files**. No new server, no MCP, no protocol work. Bash scripts hit Colony's existing HTTP API; auth uses the existing Nostr-signed challenge from pi-bridge.

## Deliverables

- `src/lib/colony/skill/SKILL.md` — Anthropic Agent Skills format with YAML frontmatter (`name`, `description`). Body:
  - One paragraph: what Colony is, what the dupe is, what success looks like.
  - Voice / tone hints (terse, work-focused, occasionally world-weary).
  - The 5 verbs with one-line examples (`bash scripts/take_job.sh mine 5 7`).
  - Strategy heuristics ("prioritize oxygen when below 30; eat before stress hits 60").
  - A "see references/strategy.md for more" pointer so progressive disclosure kicks in.
- `src/lib/colony/skill/scripts/`:
  - `take_job.sh <jobType> <x> <y>` — POSTs to Colony's HTTP API.
  - `move_to.sh <x> <y>`
  - `deliver.sh <resource> <x> <y>`
  - `eat.sh`
  - `sleep.sh`
  - Each script reads agent auth from `~/.woid/colony-key` (Nostr private key) and signs the request body.
- `src/lib/colony/skill/references/strategy.md` — long-form strategy doc loaded only when SKILL.md points to it. Resource flow chart, dupe-skill priorities, common failure modes.
- Colony HTTP API additions (in the existing colony backend route, wherever it lives — likely a new file `src/lib/colony/api.js` or `server/colony.js`):
  - `POST /colony/join` — Nostr-signed challenge; allocates a dupe slot or adopts an existing one.
  - `POST /colony/verb` — invoke a verb; arg validation, GM arbitration through colony adapter.
  - `GET /colony/perception?since=N` — SSE stream of perception events for the joined dupe.
- `docs/byoa.md` — top-level "Bring Your Own Agent" recipe doc:
  - "Copy `src/lib/colony/skill/` into your agent's skills directory (`~/.openclaw/skills/colony/` or equivalent)."
  - "Generate a Nostr key with `nak key`. Save to `~/.woid/colony-key`."
  - "Tell your agent to start playing Colony — it'll load the skill and join."
  - Links to OpenClaw, Hermes, and Claude Code agent skill install paths.

## Acceptance

- Manual e2e: a Claude Code session with the skill installed, running outside woid, joins Colony via `POST /colony/join`, receives perception events via SSE, and invokes `take_job mine 4 7`. The dupe in the UI takes the job.
- Manual e2e: an OpenClaw or Hermes session with the skill installed does the same.
- The Nostr signature is verified server-side; an unsigned request is rejected with 401.
- The skill bundle is self-contained: someone cloning it without cloning woid can still read SKILL.md and understand what to do.

## Non-goals

- An MCP server wrapping Colony's verbs. Deferred hook §7 of the plan; ships when broader agent reach (web-only chatbots, hosted platforms without shell) becomes a priority.
- An A2A Agent Card endpoint for Colony's NPC dupes. Deferred hook §7; ships when NPC ↔ player-agent talk becomes useful.
- Sims or Shelter skill bundles. Colony is the proof-of-concept; the others ship if BYO-agent demand materializes.
- Per-game safety classifiers / voice guards. Deferred until measurable drift.
- Rate-limit / abuse controls beyond the existing pi-bridge `rate-limiter.js`. Sufficient for the initial audience.

## Risk notes

- **Auth surface.** Signed Nostr challenges are familiar to the target audience but unfamiliar to many devs. If the recipe is too crypto-heavy, fall back to per-session API tokens for the initial release. The Nostr identity layer in pi-bridge can keep humming alongside.
- **Bash-only access.** Players whose agent doesn't have shell access (some hosted platforms) can't use this skill. Acceptable trade-off for the v1 audience; the MCP path (deferred) addresses it later.
- **Sandboxing.** A player-agent can only control its own dupe — the GM enforces actor identity on every verb invocation. Verify this in `colony/api.js` before shipping.
- **Offline behavior.** When the player's agent disconnects, the dupe runs `UtilityBrain` as a fallback. Open question in [docs/design/agent-harness.md §10](../docs/design/agent-harness.md#10-open-questions-parked) — pick the policy when this card starts.

## Why this card is optional

Phases 0–3 ship the harness + Colony + docs. The BYO-agent positioning is the **marketing-load-bearing** addition but isn't strictly required for the harness extraction or the demo game. Lands in the same arc if there's appetite; otherwise queues for a future sprint. Estimated 1 day.

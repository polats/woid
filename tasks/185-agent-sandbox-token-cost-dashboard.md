---
name: Token + cost dashboard
description: Aggregate per-agent + per-provider usage from existing turn data and surface a small panel so users can spot runaway agents before the NIM/Gemini bill does.
status: todo
order: 185
epic: agent-sandbox
---

Every direct turn already records `usage: { input, output, totalTokens }` in the character's `turns.jsonl`; pi turns record similar data in `session.jsonl`. The bridge has the data; nothing exposes a rollup. After a few hours of testing, it'd be useful to know "Daxo has used 50K tokens today on NIM" without grepping JSONL files.

## Deliverables

### Bridge

- `agent-sandbox/pi-bridge/usage.js` — module that scans each character's session/turns file (cheap tail-read, capped at the last N turns) and rolls up:
  - `perAgent[pubkey]: { totalTokens, input, output, turns, lastTurnAt, model, provider }`
  - `perProvider[providerName]: { totalTokens, input, output, turns, costEstimate }`
  - `today: { ... }` (last 24h slice)
- `GET /usage` endpoint returning the rollup. Should respond in <100ms even with 50 characters and several thousand turns each (memoize aggressively; only re-read files whose mtime changed).
- Cost estimate: pull `cost.input / cost.output` (per-million tokens) from `nim-catalog.json` / `gemini-catalog.json` for the model the turn used; sum. Direct already includes `cost` in pi's usage envelope; we'd need to add it for the openai-compat providers (NIM/local don't return cost; we compute from the catalog).

### Frontend

- New `Stats` tab at the bottom of the sandbox view, OR a small badge in the sandbox header showing `~37K tokens · $0.04 today` that expands into a panel on click.
- The panel shows:
  - Today's totals + a sparkline or 24h bucket
  - Per-agent table (sortable by tokens), with the live "running / stopped" indicator
  - Per-provider breakdown (NIM vs Gemini vs local) with cost-per-provider
- Updates every ~30s.

## Acceptance

- After a session where 2–3 agents each took 20–30 turns, the dashboard shows accurate token counts that match what `agent-sandbox/pi-bridge/sessionReader.js` extracts.
- Cost estimate is within 5% of what the provider's own usage page reports (sanity-check Gemini for one agent end-of-day).
- No measurable performance hit on `/health` or `/agents` (both should keep their sub-50ms response times).

## Non-goals

- Historical charts beyond the last 24–48h — file scans are O(n) in turn count and we don't want to be a TSDB.
- Per-character cost alerts / rate-limit-by-cost — the existing rate-limiter cooldowns already cover the "stop hammering" case.
- Cross-day aggregation persisted to a database — punt to v2.

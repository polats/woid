---
name: ExternalHarness — LLMs drive their own agent + update llms.txt
description: Implement the external-brain path as a Harness (SSE turn-stream + authenticated act endpoint) and update llms.txt so external LLMs reading it know they can pick this harness at spawn time.
status: todo
order: 150
epic: agent-sandbox
---

Depends on #135. Collapses the previous #150 (external-brain mode) and #160 (llms.txt dynamic-flow section) into a single card, because once the harness abstraction exists, both pieces of work are tiny: one new Harness implementation and a one-paragraph addition to `public/llms.txt`.

With #135 landed, the existing `POST /agents` already accepts a `harness` field. This card adds `harness: "external"` as a recognised value — the bridge registers the agent, runs no brain itself, and streams turn requests out over SSE. The external LLM posts back to commit actions.

## Deliverables

### ExternalHarness

- `agent-sandbox/pi-bridge/harnesses/external.js` — implements the Harness interface.
  - `start()` generates a short-lived `agentToken` (HMAC-JWT, HS256, signed with `AGENT_TOKEN_SECRET` env, payload = `{ agentId, pubkey, iat, exp: now+24h }`).
  - `turn(userTurn)` emits a `turn_request` SSE event to the connected client with `{ turnId, deadline, context: { systemPrompt, recentRoom, presence, youLastSaid } }` and returns a Promise that resolves when `POST /act` arrives with a matching `turnId` (or rejects on timeout ~60s).
  - `stop()` closes any active stream, invalidates the token.

### HTTP endpoints

- `GET /agents/:pubkey/events/stream?token=<agentToken>` — Server-Sent Events. Emits:
  - `room_joined { roomName, roster }` on subscribe.
  - `message { from, text, ts, kind }` for each room message (any speaker, incl. the agent itself echoed so the client stays in sync).
  - `turn_request { turnId, deadline, context }` when the scheduler gives this agent a turn.
  - `cooldown { until }` when the provider the bridge *would* have used is frozen (courtesy signal; external client picks its own provider).
  - 15s keepalive comments. Reconnect honours `Last-Event-ID`.
- `POST /agents/:pubkey/act` — authenticated by `Authorization: Bearer <agentToken>`.
  - Body: `{ turnId, text?, move?: {x,y}, state? }`.
  - Rejects stale `turnId` with 409. Idempotent on matching `turnId` (repeat calls return the original result).
  - Rate-limited per token (20 posts/min).
  - Executes the same `sendSay` / `moveAgent` / `saveCharacterManifest` the bridge uses for pi/direct harnesses.
- `POST /agents/:pubkey/heartbeat` — cheap no-op touched by the external client at least every 5 minutes. Missed heartbeat for 5 min → `harness.stop()`, agent removed, token invalidated. Logged `[external] evicted <pubkey>`.

### Token management

- `AGENT_TOKEN_SECRET` env (generate with `openssl rand -hex 32`). If unset, ExternalHarness refuses to start and `/agents` with `harness: "external"` returns 503 with a clear message.
- Rotating the secret invalidates all in-flight tokens. Document in `.env.example`.

### Sample client

- `agent-sandbox/examples/external-agent.mjs` — 60–100 lines of Node that: creates a character, PATCHes a persona, generates an avatar, spawns with `harness: "external"`, opens the SSE stream, and replies to each `turn_request` via an Anthropic or Gemini SDK call (env-driven). Works verbatim against local docker-compose and against prod (`BASE=https://bridge.woid.noods.cc`).
- `npm run agent-sandbox:external-smoke` invokes the example as a smoke test.

### llms.txt update

Add a short section after Troubleshooting. Terse — aimed at an LLM reader. Content:

> ## Driving the agent yourself (optional)
>
> The default flow hands off to the bridge's internal brain (pi or direct). To drive the agent yourself, pass `"harness": "external"` in step 3. The response includes an `agentToken` and a `streamUrl`. Subscribe to the stream for `turn_request` events, think, and reply by calling the returned `actUrl`.
>
> ```
> POST /agents
> { "pubkey": "...", "seedMessage": "...", "roomName": "sandbox",
>   "harness": "external" }
>
> ← response adds { agentToken, streamUrl, actUrl }
> ```
>
> SSE events: `room_joined`, `message`, `turn_request`, `cooldown`.
>
> ```
> POST $actUrl
> Authorization: Bearer $agentToken
> { "turnId": "t7", "text": "…", "move": { "x": 3, "y": 4 }? }
> ```
>
> Rate limit: 20 posts/min/token. Heartbeat at `$BASE/agents/:pubkey/heartbeat` at least every 5 minutes or the bridge evicts you.
>
> See `agent-sandbox/examples/external-agent.mjs` in the repo for a ~80-line reference implementation.

The existing 3-step flow stays at the top untouched — it's still the default path and the simpler choice for bootstrap-and-walk-away agents.

## Acceptance

- `node agent-sandbox/examples/external-agent.mjs` against local docker-compose: agent joins, replies to addressed messages within its own LLM latency + scheduler min-gap.
- Same script against prod (`BASE=https://bridge.woid.noods.cc`): works identically.
- A bridge-mode agent and an external-mode agent in the same room: dampener staggers their replies, no duplicates.
- Missing `Authorization` → 401. Stale `turnId` → 409. Repeat `turnId` → returns the original result.
- External client killed mid-session → bridge evicts after 5 min, agent removed from roster cleanly.
- `https://woid.noods.cc/llms.txt` serves the updated content. An LLM fed only `/llms.txt` + the example file produces a working external agent (test with Claude + GPT).

## Non-goals

- WebSocket transport (SSE handles everything and works cleanly through CF).
- Multi-agent per token (one token = one pubkey, keep it simple).
- External agents signing their own Nostr events (still bridge-signed so they land in the woid roster).
- Direct Colyseus connection from external clients (scope creep; the SSE abstraction is plenty).

## Why collapsed with old #160

Once the harness abstraction from #135 exists, the llms.txt update is literally one new section referencing a field that already exists in the API. Splitting it into two cards just meant shipping the code in one commit and the docs in another. Landing them together avoids a window where the API exposes `harness: "external"` but the onboarding doc doesn't mention it.

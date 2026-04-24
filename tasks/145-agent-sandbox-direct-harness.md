---
name: DirectHarness — call-my-ghost-style direct SDK brain
description: Implement a Harness that skips pi entirely: one SDK call per turn, structured JSON response parsed into actions. Mirrors call-my-ghost's brain-gemini pattern.
status: todo
order: 145
epic: agent-sandbox
---

Depends on #135. With the harness interface extracted, the sandbox can finally offer the call-my-ghost-style brain: one SDK request per turn, structured JSON out, actions executed in-process. No subprocess, no skills, no `/internal/post` loopback. Most woid characters don't need pi's coding-tool arsenal; this becomes the sensible default.

## Deliverables

### Core

- `agent-sandbox/pi-bridge/harnesses/direct.js` — **DirectHarness**. Implements the Harness interface from #135. On each `turn(userTurn)`:
  1. Build a messages array from the in-memory history + `{ role: "user", content: userTurn }`.
  2. Call the appropriate provider SDK.
  3. Expect JSON matching a strict schema (validated with Zod or hand-written, not a whole library).
  4. Return parsed `actions[]` + `thinking` + `usage` to the bridge.
  5. Append the assistant response to history (cap at N most-recent turns, e.g. 20).

### System prompt schema

Keep `buildSystemPrompt` working — append a short structured-output hint:

> Respond with ONLY JSON matching `{ "thinking": string?, "say": string?, "move": { "x": int, "y": int }?, "state": string? }`. Omit keys you don't want to change. Never wrap in markdown fences.

### Provider adapters

Three providers cover all real use cases today. Each is a tiny fetch or SDK wrapper — no framework.

- `agent-sandbox/pi-bridge/providers/gemini.js` — `@google/genai` (already on apoc-radio-v2; mirror their `generateJson` pattern).
- `agent-sandbox/pi-bridge/providers/nim.js` — plain `fetch` to NIM's OpenAI-compatible endpoint. Uses existing `NVIDIA_NIM_API_KEY` env + `nim-catalog.json` for model lookup.
- `agent-sandbox/pi-bridge/providers/local.js` — plain `fetch` to `LOCAL_LLM_BASE_URL` OpenAI-compatible endpoint. Same shape as NIM.

Each exports `generateJson({ systemPrompt, messages, model }) → { content, thinking?, usage? }`. The DirectHarness is the only caller; providers stay focused and testable.

### History persistence

- `agent-sandbox/pi-bridge/harnesses/direct-session.js` — read/append a `turns.jsonl` file per character (next to pi's `session.jsonl`). Each line: `{ ts, role, content, harness: "direct" }`. Reading is cheap (tail N lines) and keeps the format inspector-compatible.
- On `stop()`, flush.

### Selection + UI

- Character manifest field `harness` recognizes `"direct"`.
- UI: dropdown in the AgentProfile drawer alongside the model picker, values `pi | direct`. Defaults to `direct` for new characters going forward; existing characters keep `pi`.
- `POST /agents { harness: "direct" }` override works at spawn time.

### Inspector

- AgentWaterfall's "Live" tab renders DirectHarness events (`turn_start`, `think`, `action`, `turn_end`) — small DOM changes. Pi sessions still render pi-specific events since PiHarness is unchanged.

## Acceptance

- Create a character, flip its harness to `direct` in the UI, spawn, chat. Replies arrive in <1s (no subprocess cold start, one SDK roundtrip).
- Actions: say / move / state all execute correctly. Self-state updates persist in `agent.json`.
- Tokens + cost for direct-harness turns match what the provider's own usage API reports (sanity-check first few turns manually).
- A rate-limit (NIM 429) on a direct-harness agent triggers the existing rate-limiter cooldown and is reported via `/health.cooldowns`, same as pi.
- `pi` harness continues to work for characters that select it — no regression.

## Non-goals

- Tool use beyond `say`/`move`/`state`. If a character needs bash access, use pi.
- OpenAI / Anthropic SDKs unless/until we actually have a use case — NIM/Gemini/local cover everything in the sandbox today.
- Streaming partial tokens to the client — one response per turn is fine for this round.
- Auto-summarisation / compaction of history — cap at N most-recent turns and punt.

---
name: Extend llms.txt with the dynamic (external-brain) onboarding flow
description: Once external mode ships (#150), add an opt-in "drive the agent yourself" step to llms.txt so external LLMs know they can participate, not just bootstrap.
status: todo
order: 160
epic: agent-sandbox
---

Depends on task #150. Today's `public/llms.txt` is a three-step bootstrap that hands off to pi. After #150 ships, document the optional external-driven flow so an LLM reading llms.txt can choose:

- **Easy mode** (existing 3 steps) — bootstrap and walk away; pi drives.
- **Driver mode** (new) — bootstrap and then stay connected, receiving turn requests and posting back.

## Deliverables

- Add a new top-level section `## Driving the agent yourself (optional)` after Troubleshooting. Short — aimed at an LLM reader.
- Include:
  - The `mode: "external"` flag on `POST /agents` and the `agentToken` in the response.
  - SSE event reference (`room_joined`, `message`, `turn_request`, `cooldown`), with minimal JSON samples.
  - `POST /agents/:pubkey/act` request/response shapes.
  - Heartbeat expectations (5 min idle → evicted).
  - Rate limit (20 posts/min/token).
- Expand the curl example with a `step 3b` shell snippet using `curl -N` for the stream + a reply loop.
- Add a pointer to `examples/external-agent.mjs` for a working implementation.
- Keep the existing easy-mode flow intact and make clear it's the default (one line at the top of the new section).

## Acceptance

- The Vercel-deployed `https://woid.noods.cc/llms.txt` includes the new section.
- Fact-check pass: every endpoint, field name, and error code in the new section matches what #150 actually ships. Run the `curl -N` example end-to-end against prod and confirm it gets turn requests and posts back cleanly.
- An LLM reading the file (test with Claude, GPT) produces a correct external agent without reading source.

## Non-goals

- Removing the easy-mode flow (keep as default).
- Tutorial-length — llms.txt stays terse; link to the example for the full loop.

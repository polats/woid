---
name: Documentation pass — harness system + onboarding
description: docs/ hasn't been touched since the harness abstraction landed. Add a "Choosing a brain" page so anyone new to the project understands pi vs direct vs external and when to pick each.
status: todo
order: 195
epic: agent-sandbox
---

The agent sandbox grew three distinct brains (pi, direct, external) and a prompt-style A/B (minimal vs dynamic) in the last sprint. None of that is documented in `docs/` — anyone arriving at the project has to read the task cards or the source to figure out what's there.

## Deliverables

### `docs/agent-sandbox.md` — refresh

Currently focused on the original pi-only flow. Update to reflect the harness abstraction:
- Architecture diagram (or a clear paragraph): bridge owns identity + Nostr publish; harness produces actions from prompt.
- Lifecycle of a turn through each harness, side by side.
- "Which harness should I use?" matrix.

### `docs/harnesses.md` — new

The dedicated reference page:
- **pi** — when to use (need bash/read/write tools, want pi's compaction, complex tool-use). Tradeoffs (subprocess overhead, ~500–800 lines of skill machinery).
- **direct** — when to use (default; most NPCs). What providers are wired (Gemini SDK, NIM/local via OpenAI-compat fetch). How to extend.
- **external** — when to use (you want to drive an agent yourself). Quick-start pointing at `agent-sandbox/examples/external-agent.mjs` + `public/llms.txt`.

### `docs/prompt-styles.md` — new

The minimal vs dynamic A/B. Walk through the call-my-ghost comparison findings (numeric mood, anti-silence, one-action emphasis, tone lock). Copy the exact prompt blocks so a reader can compare side-by-side without reading source.

### Update `docs/welcome.md`

Add a one-line teaser pointing at the new agent-sandbox docs ("Need to spawn LLM agents? Start at `/docs/agent-sandbox`").

### `RAILWAY.md`, `VERCEL.md`, `CLOUDFLARE.md`

Already up to date with the gotchas hit this session — leave alone unless something new breaks.

## Acceptance

- A new contributor (or a future Claude instance) can read `docs/agent-sandbox.md` + `docs/harnesses.md` and confidently pick a brain for a new character without reading source.
- The dynamic/minimal split is explained well enough that someone could write their own third prompt style as a follow-up.
- Docs build cleanly via the existing markdown viewer in the sandbox UI (test by navigating to `/docs/...` in the running app).

## Non-goals

- API reference auto-generation — the JSDoc in `harnesses/types.js` is enough for now.
- Tutorials — keep this reference-style. Onboarding flow tutorials can come later if there's demand.
- Updating `tasks/` cards — those are point-in-time work logs, not documentation.

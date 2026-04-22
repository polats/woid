# Woid

Plan, diagram, and run live LLM-agent experiments against reference projects — all in one tiny React + Vite app.

Woid bundles a task board, a React Flow diagramming surface, a Claude-powered chat, a Playwright video-archive, and an optional Dockerised LLM-agent sandbox (Colyseus rooms + Nostr relay + pi coding agents) behind a single sidebar. Fork it as a template and tailor to your project.

## Use as a template

Click **Use this template** on GitHub (or clone this repo), then:

```bash
npm install
npm run dev
```

Edit `woid.config.json` to brand the project:

```json
{
  "name": "Your Project",
  "description": "One-line description.",
  "home": "welcome",
  "features": { "agentSandbox": true }
}
```

## What's inside

- **Tasks** — Trello-style board backed by markdown files in `tasks/` ([format](docs/tasks-format.md))
- **Agent Sandbox** — optional, Docker-based. Colyseus room + strfry Nostr relay + pi coding-agent runtime. Pick a model from NVIDIA NIM, Google Gemini, or a local llama.cpp server ([local-llm setup](docs/local-llm.md)). Spawn named agents with seed messages, watch their live thought / tool-call / result stream in an inspector drawer, see every post in the relay feed; a persistent "Administrator" identity auto-announces each arrival. ([docs](docs/agent-sandbox.md))
- **Testing** — Playwright e2e harness. Every run is archived with video + pass/fail data; browsable at `#/testing` inside the app. ([docs](docs/testing.md))
- **Diagrams** — React Flow canvases stored as markdown with a fenced JSON block in `diagrams/`
- **References** — GitHub repos added as git submodules under `references/`; click to render their README
- **Docs** — any `.md` file in `docs/` shows in the sidebar; start from `welcome.md`
- **Chat** — floating Claude chat that can edit files in this project (uses your ambient Claude Code session)
- **Devlog** — conventions for keeping an incident log in `docs/devlog/` ([docs](docs/devlog.md))

## Layout

```
server/          Vite middleware plugins (tasks, diagrams, github, references, chat, testing)
src/             React app
docs/            Markdown docs shown in the sidebar (incl. docs/devlog/)
tasks/           One markdown file per card
diagrams/        One markdown file per diagram
references/      Git submodules of projects you're studying
agent-sandbox/   Dockerised relay + Colyseus room + pi-bridge stack (optional feature)
e2e/             Playwright specs
testing/         Custom reporter + session archive (sessions/ is gitignored)
scripts/         Dev helpers (smoke test, sandbox smoke, etc.)
woid.config.json Per-project name / description / home doc / feature flags
```

## Testing

```bash
npm install -D @playwright/test typescript
npx playwright install chromium

npm run dev          # terminal 1
npm run smoke        # terminal 2: pre-flight health check
npm run test:e2e     # terminal 2: Playwright specs
```

Past runs (videos + pass/fail + timestamps) are browsable inside the app at `#/testing` — no separate viewer server needed. See [docs/testing.md](docs/testing.md) for details.

## Agent Sandbox

```bash
cp agent-sandbox/.env.example agent-sandbox/.env
# set NVIDIA_NIM_API_KEY

npm run agent-sandbox:up     # start relay + room-server + pi-bridge + jumble
npm run dev                  # open http://localhost:5173/#/agent-sandbox
```

Pick a model, name an agent, hit Spawn. The admin character welcomes them on the Nostr relay, the agent runs in a container, and you can click the row to inspect its live thinking stream. See [docs/agent-sandbox.md](docs/agent-sandbox.md).

## Auth

- **GitHub** — optional; token-based API access for private repos. Stored in `.github-token` (gitignored).
- **Claude** — no login needed. The chat uses your existing Claude Code CLI session.
- **Agent Sandbox** — no auth in MVP; localhost-bound only. Do not expose to the internet.

# Welcome

Woid is a base repo for planning code, scratchpadding diagrams, and running live LLM-agent experiments while you study reference projects.

## Using this template

1. Click **Use this template** on GitHub (or clone the repo).
2. Edit `woid.config.json` — set `name`, `description`, and the `home` doc.
3. `npm install && npm run dev`.

## What's here

- **Tasks** — a Trello-style board. Cards are markdown files in `tasks/` with `status` / `order` frontmatter. Drag to reorder; edits save to disk.
- **Agent Sandbox** — spawn LLM agents in a Dockerised Colyseus room + Nostr relay stack; pick their model, watch their live "thinking" stream in the inspector drawer, and see every post in the relay feed. Feature-flagged via `features.agentSandbox` in `woid.config.json`. See [agent-sandbox](agent-sandbox.md).
- **Testing** — Playwright e2e harness. Past runs (videos + pass/fail) are browsable in the sidebar under *Testing*; specs live in `e2e/`. See [testing](testing.md).
- **Diagrams** — a React Flow canvas per diagram. Each diagram is a markdown file in `diagrams/` with a fenced JSON block holding nodes and edges.
- **References** — add GitHub repos as git submodules under `references/`. Selecting a reference renders its README.
- **Docs** — any `.md` file in `docs/` shows in the sidebar. Start here by editing this file.
- **Chat** — the floating button (bottom-right) opens a chat with Claude, scoped to this project. It uses your ambient Claude Code session and can edit files in place.

## Agent Sandbox quickstart

```bash
cp agent-sandbox/.env.example agent-sandbox/.env
# set NVIDIA_NIM_API_KEY

npm run agent-sandbox:up     # start relay + room-server + pi-bridge + jumble
# then open the "Agent Sandbox" link in the sidebar
```

Pick a model, name an agent, spawn. The admin character welcomes them on the relay immediately; the agent's live thought/tool/result stream renders in a drawer when you click its row.

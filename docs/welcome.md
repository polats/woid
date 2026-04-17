# Welcome

Woid is a base repo for planning code and scratchpadding diagrams while you study reference projects.

## Using this template

1. Click **Use this template** on GitHub (or clone the repo).
2. Edit `woid.config.json` — set `name`, `description`, and the `home` doc.
3. `npm install && npm run dev`.

## What's here

- **Tasks** — a Trello-style board. Cards are markdown files in `tasks/` with `status` / `order` frontmatter. Drag to reorder; edits save to disk.
- **Diagrams** — a React Flow canvas per diagram. Each diagram is a markdown file in `diagrams/` with a fenced JSON block holding nodes and edges.
- **References** — add GitHub repos as git submodules under `references/`. Selecting a reference renders its README. Login with a GitHub token to add private repos.
- **Docs** — any `.md` file in `docs/` shows in the sidebar. Start here by editing this file.
- **Chat** — the floating button (bottom-right) opens a chat with Claude, scoped to this project. It uses your ambient Claude Code session and can edit files in place.

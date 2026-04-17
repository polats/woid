# Woid

A base repo for planning code and scratchpadding diagrams while you study reference projects.

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
  "home": "welcome"
}
```

## What's inside

- **Tasks** — a Trello-style board backed by markdown files in `tasks/`
- **Diagrams** — React Flow canvases stored as markdown with a fenced JSON block in `diagrams/`
- **References** — add GitHub repos as git submodules under `references/`; click to render their README
- **Docs** — any `.md` file in `docs/` shows in the sidebar
- **Chat** — floating Claude chat that can edit files in this project (uses your ambient Claude Code session)

## Layout

```
server/          Vite middleware plugins (tasks, diagrams, github, references, chat)
src/             React app
docs/            Markdown docs shown in the sidebar
tasks/           One markdown file per card
diagrams/        One markdown file per diagram
references/     Git submodules of projects you're studying
woid.config.json Per-project name / description / home doc
```

## Auth

- **GitHub** — paste a personal access token once (scopes `repo` + `read:user`). Stored locally in `.github-token` (gitignored).
- **Claude** — no login needed. The chat uses your existing Claude Code CLI session.

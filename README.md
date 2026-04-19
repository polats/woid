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

- **Tasks** — a Trello-style board backed by markdown files in `tasks/` ([format](docs/tasks-format.md))
- **Diagrams** — React Flow canvases stored as markdown with a fenced JSON block in `diagrams/`
- **References** — add GitHub repos as git submodules under `references/`; click to render their README
- **Docs** — any `.md` file in `docs/` shows in the sidebar
- **Chat** — floating Claude chat that can edit files in this project (uses your ambient Claude Code session)
- **E2E testing** — opinionated Playwright harness with per-run video sessions and a browsable viewer ([docs](docs/testing.md))
- **Devlog** — conventions for keeping an incident log in `docs/devlog/` ([docs](docs/devlog.md))

## Layout

```
server/          Vite middleware plugins (tasks, diagrams, github, references, chat)
src/             React app
docs/            Markdown docs shown in the sidebar (incl. docs/devlog/)
tasks/           One markdown file per card
diagrams/        One markdown file per diagram
references/      Git submodules of projects you're studying
e2e/             Playwright specs
testing/         Custom reporter + session viewer (sessions/ is gitignored)
scripts/         Dev helpers (smoke test, etc.)
woid.config.json Per-project name / description / home doc
```

## Testing

```bash
npm install -D @playwright/test typescript
npx playwright install chromium

npm run dev          # terminal 1
npm run smoke        # terminal 2: pre-flight health check
npm run test:e2e     # terminal 2: Playwright specs
npm run test:view    # browse past runs at http://localhost:3333/viewer.html
```

See [docs/testing.md](docs/testing.md) for the full rundown.

## Auth

- **GitHub** — paste a personal access token once (scopes `repo` + `read:user`). Stored locally in `.github-token` (gitignored).
- **Claude** — no login needed. The chat uses your existing Claude Code CLI session.

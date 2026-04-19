# Tasks format

The tasks board is backed by markdown files in `tasks/`, one per card. The board UI in woid reads this folder directly, but the format is designed to be readable and editable without the UI — you can add a task by dropping a file in.

## File shape

```markdown
---
name: Short task title
description: One-line description shown in list views
status: todo
order: 10
---

Long-form markdown body. Explain what needs to happen, what's blocking it,
links to code / commits / devlog entries.

Bullets, headings, code blocks all render.
```

### Frontmatter fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Card title. |
| `description` | no | One-line summary for dense views. |
| `status` | yes | One of `todo`, `in_progress`, `blocked`, `done`. |
| `order` | no | Integer. Lower values sort earlier. Gaps between numbers (10, 20, 30) let you insert without renumbering. |

Add your own fields (`owner`, `priority`, `epic`, …) as needed — the UI ignores unknown fields but round-trips them intact.

## Filename conventions

`{number}-{slug}.md`, e.g. `042-add-oauth.md`. The number makes `ls` match priority order and makes cross-references (`see #042`) natural. Slugs are kebab-case.

## Why markdown

- Grep-able. `grep -l "status: blocked" tasks/*.md` gives you the blocked list without tooling.
- Diff-friendly. Task history is in git — you can see when cards moved and who moved them.
- Editor-agnostic. Works in VS Code, vim, the woid UI, or any markdown tool.
- Archivable. When a project winds down, the tasks/ folder is a complete log.

## When to use tasks vs devlog vs code comments

- **Code comment** — something a reader of this specific function needs to know.
- **Task** — work that needs doing but isn't done yet.
- **Devlog** — something that already happened and shouldn't happen again.

If you catch yourself writing the same note in more than one place, pick one home for it.

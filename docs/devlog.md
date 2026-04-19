# Devlog

An append-only log of incidents, gotchas, and non-obvious fixes. Lives in `docs/devlog/` as one markdown file per day (`YYYY-MM-DD-slug.md`).

## Why have one

In a long-running project, the expensive knowledge isn't "how the code works" — you can read that. It's the landmines: the prerender that silently skips routes when you touch one config key, the library that caches a bundle and needs `--force`, the race condition that only appears when two services start in the wrong order. That kind of knowledge doesn't belong in code comments (too local) or a wiki (gets stale, nobody reads). It belongs in a chronological log you can grep.

The devlog is **not documentation**. It's a diary of things that wasted your time, written so they won't waste someone else's.

## When to add an entry

- You spent more than 20 minutes on a bug whose root cause wasn't obvious.
- You fixed something that'll almost certainly break the same way again.
- You found a non-obvious interaction between two libraries / services / configs.
- You onboarded someone and had to explain a trap that isn't in the README.

## Format

```markdown
# 2026-04-19 — short-slug

**Symptom:** what the user / CI / browser actually showed.

**Root cause:** one paragraph — the actual mechanism, not a retelling of the fix.

**Fix:** commit SHA + 1–2 sentences.

**Trap for next time:** the shape of the bug, so future-you can recognize it.
```

## Ground rules

- **Link the commit.** Every entry mentions a SHA.
- **Name the symptom first.** That's how someone finds the entry six months later when they're hitting the same thing.
- **Write the trap, not the victory.** "Prerender fails if X" beats "we did Y". Future readers need the failure mode; the fix is in the commit.
- **Short is fine.** One paragraph is often enough. Don't pad.

## Index

See [docs/devlog/README.md](./devlog/README.md) for the running list of entries.

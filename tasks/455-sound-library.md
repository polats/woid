---
name: World — Sound library
description: Curated library of ambient loops, UI cues, and per-action SFX that the Sandbox stage can play, plus a browser view to audition and tag clips. Foundation for later character-driven audio (footsteps, object interactions, scheduled events).
status: todo
order: 455
epic: world
related: [245, 285, 355]
---

The Sandbox stage is currently silent. Before we wire sound into actions or smart objects, we need a managed library of clips with consistent metadata so the runtime can ask for "kitchen ambient" or "door open" without hard-coding paths.

## Slices

### Slice 1 — Storage + manifest

- `assets/sounds/` directory with subfolders by category: `ambient/`, `ui/`, `actions/`, `objects/`, `music/`.
- `assets/sounds/manifest.json` — array of `{ id, path, category, tags[], duration_ms, loopable, license, source }`.
- Lint script that validates: every file has a manifest entry, every entry resolves to a file, durations match probe output.

### Slice 2 — Bridge endpoints

- `GET /sounds` returns the manifest (cached).
- `GET /sounds/status` returns `{ count, by_category, total_duration_ms }` for the sidebar pill.
- Static file serving for `/sounds/<id>` (or signed URLs if we move clips to GCS).

### Slice 3 — Browser view

- `src/views/SoundLibrary.jsx` — list/detail like `Personas.jsx`. Filter by category + tag, audition with an inline `<audio>` player, copy-id button.
- Sidebar entry under World with count pill.

### Slice 4 — Initial content pass

- Seed ~20 clips covering: 3-4 ambient room loops, basic UI cues (notification, error, confirm), a handful of action SFX (footstep, door, drink, type). All CC0 / CC-BY with attribution captured in the manifest.

## Acceptance

- `#/sounds` lists every seeded clip, filterable by category, auditionable in-browser.
- The manifest lints clean.
- Sidebar pill shows count and updates when manifest changes.
- A clip can be referenced by id from the runtime (even if no caller wires it yet).

## Non-goals

- Playing sounds from agent actions — that's a follow-up task.
- Procedural / generative audio.
- Mixing, ducking, spatialization.
- User uploads through the UI.

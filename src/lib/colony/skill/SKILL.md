---
name: colony
description: Play "Colony" — a small ONI-flavored colony sim running inside the woid project. The game is a 24x16 tile grid with dupes, ore deposits, beds, and a kitchen. You control one dupe; the others run on a built-in utility AI. Useful when the user asks to "play Colony", "drive a dupe", "test the woid harness", or wants to demonstrate a bring-your-own-agent setup.
---

# Colony — agent skill

You are joining **Colony**, a colony sim demo built on the [woid agent harness](https://github.com/woid). Each dupe is a character on a tile grid. You drive one dupe by emitting verbs; the world server validates and applies them; you receive perception events when things happen near you.

This skill is for the **bring-your-own-agent** flow: your runtime (OpenClaw / Hermes Agent / Claude Code / etc.) loads this skill, you authenticate, you start playing.

## The dupe you control

When you join, the server allocates you a free dupe slot and tells you its ID. From then on, every action you take is scoped to that dupe — the GM rejects verbs targeting other dupes' state.

Stats your dupe carries:

- **Needs**: `food` and `energy`, both 0–100. Decay each tick. Below 30 fires a `need_low` perception event.
- **Stress**: 0–100. Driven by recent moodlets. Above 80 you should rest immediately.
- **Skills**: `mining`, `cooking`. Slowly improve with use.
- **Position**: `{ x, y }` on the 24x16 grid.

## Verbs

Five actions. Each one moves your dupe to the target tile (movement is teleport in this build) and applies its effect.

| Verb | Args | Effect |
|---|---|---|
| `mine` | `{ x, y }` | Extract one ore from an `ore_deposit` tile. Drains a little energy. |
| `eat` | `{ x, y }` | At a `kitchen` tile, restore food need by ~35. |
| `sleep` | `{ x, y }` | At a `bed` tile, restore energy by ~60, drop stress by 8. |
| `move_to` | `{ x, y }` | Walk to a tile. Instrumental — most verbs include movement. |
| `idle` | `{}` | Wait. Fallback. |

## Strategy

The world starts with:
- Ore deposits along the left edge (`x = 2`, `y = 2, 4, 6, 8, 10, 12`).
- Three beds on the right edge (`x = 20`, `y = 4, 6, 8`).
- One kitchen near the center (`x = 12, y = 12`).

A good loop: **mine until your needs hit ~50, then eat, then sleep, then mine again.** The built-in dupes do the same; the goal of the demo is to show coherent autonomous behavior.

For deeper strategy notes (multi-dupe coordination, stress management, contention with NPC dupes), read [references/strategy.md](references/strategy.md). Only load it when you need it — your initial system prompt should be light.

## Voice

Colony is a calm, work-focused sim. When your dupe speaks (via `say` if/when speech ships in this game), it should sound terse and grounded — closer to a foreman's clipboard note than a cheerful assistant. Reference: ONI flavor text. Never break the corporate-mundane voice.

## Transport (deferred)

The Colony HTTP API for external agents (`/colony/join`, `/colony/verb`, `/colony/perception`) is not yet wired up — see [docs/byoa.md](../../../../docs/byoa.md) for the deferred hook status. Today this SKILL.md is shipped as the **documentation template**: external adopters can clone the woid repo, run the in-browser demo to inspect Colony's behavior, and (when the HTTP API ships) point their agent at this skill bundle without modifications.

When the API is live, the scripts in [scripts/](scripts/) are the canonical way to invoke each verb. Until then, the scripts print a "not yet implemented" message that explains exactly what they will do.

## What to do right now

1. Wait for a `colony:joined` perception event with your `dupeId`.
2. Run `move_to` to a sensible work tile.
3. Mine, eat, sleep as the loop demands.
4. Watch the perception stream for `colony:ore_mined` events from other dupes — you'll see your peers working.

# room

Interact with the 2D room you're in. Use ONLY this script for room actions —
do not try curl or other HTTP tools directly.

## Move

```bash
bash .pi/skills/room/scripts/room.sh move <x> <y>
```

- `x` and `y` are 0-indexed integer tile coordinates.
- The server clamps out-of-bounds values, so `move 999 999` is fine — you'll
  land at the far corner.
- Adjacent-agent arrivals trigger the other agent's next turn with an
  `arrival` notification; use this to greet someone, chase someone, or back
  off if the scene's tense.

## Rules

- One move per turn is usually enough. Don't spam moves.
- Stepping onto another agent's tile is allowed — the grid isn't blocking.
- You don't have to move every turn. Standing still is a choice.

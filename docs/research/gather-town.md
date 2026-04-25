# Gather.town — 2D tile worlds with hybrid sync

The canonical 2D tile-based virtual office. Rendered in canvas/WebGL with a custom map editor. Each map is a grid of **32×32 px tiles** ([Mapmaker docs](https://support.gather.town/help/map-making)).

---

## World data

A map is a stack of layers:

- **Floor / background tiles** — purely visual
- **Collisions** — boolean per tile
- **Objects** — sprites with optional `interactionType`: embedded website, video, image, note, whiteboard, doc, game
- **Portals** — tile → destination map + spawn coords
- **Spawn tiles**
- **Private Areas** — regions tagged with an ID; users in tiles sharing the same private-area ID can hear each other regardless of distance, and cannot hear outside

## Real-time sync — hybrid

A WebSocket connection to Gather's game servers carries authoritative state:

- position updates
- chat
- presence
- object interactions

WebRTC (peer-to-peer or via SFU for larger spaces) carries audio/video.

## Proximity audio

Tile-gated. By default the client only opens RTC tracks to peers within a 5-tile Chebyshev radius (configurable). Private Areas override the distance check — anyone in the same Private Area hears each other, regardless of grid distance.

## Movement

Continuous tile-grid stepping. WASD/arrow keys queue tile moves; click-to-walk runs A* pathfinding over the collision layer **client-side** and streams the path to the server. The server validates tile collisions to prevent walk-through-walls.

## Interactive objects

Whiteboards (tldraw/Excalidraw), embedded websites in iframes, podiums that broadcast a speaker's audio map-wide. Each is just an object template with an interaction handler — opens an iframe overlay when the user is on an adjacent interactable tile.

## Access control

Per-Space (top-level container) with role-based membership: Owner / Admin / Builder / Member / Guest. Plus per-area permissions inside a map.

---

## Lessons for an LLM sandbox

- **Layered grid data.** A room is not one big bitmap. It's a stack of floor/collision/object/portal layers. Each layer is independently editable and serializable. Same shape would work for our world config JSON.
- **Tile-distance gating for "who hears whom."** Instead of broadcasting every message to every agent in a room, gate by tile distance. Cheap and intuitive. Maps onto our future perception system: agents only "hear" speech from adjacent tiles.
- **Interaction objects as data, not code.** Gather's whiteboard / embedded website / podium are config entries with a `kind`, not bespoke implementations. Same shape works for our `WorldObject { kind, verbs, state }`.
- **Hybrid sync.** Authoritative state over WebSocket (small, frequent, must be reliable). Heavy/streamy stuff (audio, video, large updates) over RTC. We don't need RTC, but the principle — "different durabilities for different data" — is reusable.
- **Server-validated movement.** Client A* is fine for UX; the server still must verify each step against the collision layer. Don't trust the client to honor walls.

---

## Sources

- [Gather Mapmaker Docs](https://support.gather.town/help/map-making)
- [Gather Engineering blog (Substack)](https://gather.engineering)
- Phillip Wang / Kumail Jaffer talks on building Gather (YC W20 demo, Substack posts)

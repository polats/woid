# Building — multi-room map model

The current map is a single `width × height` grid (16×12 by default). Characters and objects live as `{x, y}` tiles in one big space. For the [vertical slice](vertical-slice.md) audience to feel right, this needs to become a **building of rooms connected by hallways**, in the [Tomodachi Life](../research/tomodachi-life.md) shape: each character has *their* apartment, the building has communal space, and the whole thing **expands as new characters and objects unlock**.

This doc is the migration plan and target architecture. It's a structural change (data model + bridge + server + UI), so the work earns its own task ([#285](../../tasks/285-multi-room-building.md)).

---

## 1. Goals

1. **Each character has their own room.** The "my apartment" affordance is the load-bearing emotional unit for this audience.
2. **The map grows.** New characters add apartments; new objects open new shared rooms (kitchen unlocks when first kettle bought; lobby unlocks at character #3).
3. **Inheriting the world.** [Day 1's hook](vertical-slice.md#5-day-1--first-occupant) (the previous tenant's tea) requires the player's apartment to exist *with state in it* before they spawn. A multi-room model lets us seed pre-populated rooms.
4. **Browsable spatial structure.** The user can scroll the building, zoom into any apartment, see who lives where.
5. **Compatible migration.** The current single-room model must keep working during rollout; existing workspaces must auto-upgrade.

---

## 2. Target schema

### 2.1 Building / Rooms

```ts
type Building = {
  id: string                  // "default" for now; multi-building later
  name: string                // "The Building"
  rooms: Room[]
  unlock_state: {             // gates which rooms exist
    apartments_owned: number      // grows with character count
    communal_unlocked: string[]   // ids of unlocked communal rooms
  }
}

type Room = {
  id: string                  // "apt-1A", "hallway-1", "kitchen", "lobby"
  name: string                // "1A — Marisol's apartment"
  type: "apartment" | "hallway" | "communal" | "outdoor"
  owner_pubkey?: string       // present for apartments only
  width: number               // tile size of the room interior
  height: number
  // Position in building canvas (for rendering; not gameplay-relevant)
  canvas_x: number
  canvas_y: number
  doors: Door[]               // connections to other rooms
  flags: {
    locked?: boolean          // room exists but characters cannot enter
    private?: boolean         // owner-only
    scene_radius?: number     // override for [scenes.js](../../agent-sandbox/pi-bridge/scenes.js)
  }
}

type Door = {
  to_room: string
  // Both sides of the door reference each other; doors are persisted once
  // and rendered on both rooms.
  from_x: number              // tile in this room
  from_y: number
  to_x: number                // tile in the destination room
  to_y: number
}
```

### 2.2 Position becomes room-qualified

Today: `{ npub, x, y }`.
Target: `{ npub, room_id, x, y }`.

```ts
type Position = {
  room_id: string
  x: number                   // local to the room
  y: number
}
```

Smart-object `position` likewise becomes `{ room_id, x, y }`.

The Colyseus presence state mirrors this: each agent's transform now carries `room_id`. The server has to rewrite a few places that assume a single coordinate space.

### 2.3 Default starter building

Day-0 layout for a fresh workspace:

```
                ┌─────────┐
                │ outdoor │  (street, mostly cosmetic)
                └────┬────┘
                     │
        ┌────────────┴────────────┐
        │         lobby           │  (communal, unlocks at 3+ residents)
        └────┬────────────┬───────┘
             │            │
┌────────┐   │  hallway  │   ┌────────┐
│  1A    ├───┤ (1F)      ├───┤  1B    │
│ Mara's │   │           │   │ player │
└────────┘   └───────────┘   └────────┘
                  │
                  │
             ┌────┴────┐
             │ stairs  │  (locked until apartment 2A unlocks)
             └─────────┘
```

So at Day 0:
- 2 apartments (1A owned by founder Mara; 1B for the player).
- 1 hallway connecting them.
- 1 outdoor room (cosmetic; characters don't enter unless arc says so).
- Lobby and 2A are *defined but locked* (`flags.locked: true`).

When a third resident is welcomed, 2A unlocks. When a fourth, 2B. When 3+ residents exist, lobby unlocks.

---

## 3. The unlock system

The shop sells two kinds of things, each opening up the world differently:

### 3.1 Object purchases (open affordances inside existing rooms)

Buying a cookbook places it in a room and unlocks the `cook_for(target)` verb for characters in that room. Existing card pool widens because more cards' triggers are satisfied.

### 3.2 Room unlocks (open new spaces in the building)

| Unlock | Condition | What appears |
|---|---|---|
| **2A apartment** | Welcome a 3rd resident | New apartment + hallway extension |
| **2B apartment** | Welcome a 4th resident | New apartment |
| **Communal kitchen** | First shared object placed (kettle, cookbook, fridge accessory) | New room between hallway and lobby |
| **Lobby** | 3+ residents | New room; new arrival cards become eligible |
| **Stairs / floor 2** | 4+ residents | Extends building vertically |
| **Garden** | 1st houseplant placed | Small outdoor room with tend-plant affordances |

Room unlocks emit `room_unlocked` perception events so witnessing characters react ("there's a kitchen now") and the recap can lead with it.

### 3.3 Why the building shape matters

Three audience-tuning effects:

1. **"My apartment" is a real emotional anchor.** Tomodachi Life sold 6.7M because of this; we're replicating it. Each character has *their corner*, and the player's apartment is *theirs*.
2. **Spatial unlocks are durable rewards.** Currency that buys a *room* (not a temporary buff) compounds with relationships.
3. **Cards can target rooms.** `ambient.morning-kettle` is "in the communal kitchen at sunrise" — a precise spatial trigger. Single-room model can't express this.

---

## 4. UI

### 4.1 Building canvas

The map view replaces the current single-grid `RoomMap.jsx` with a building canvas:

```
┌───────────────────────────────────────────────┐
│              outdoor                          │
│ ─────────────────────────────                 │
│                                               │
│ ┌─lobby──────────┐                            │
│ │                │                            │
│ └──┬──────────┬──┘                            │
│    │          │                               │
│ ┌─1A┐  ┌─hall┐  ┌─1B─┐                        │
│ │   │  │     │  │ 🛏 │                        │
│ │ 🛏│  │     │  │ 🪑 │                        │
│ └───┘  └─────┘  └────┘                        │
└───────────────────────────────────────────────┘
```

Each room is its own sub-grid with the existing tile renderer scaled down. The canvas pans/zooms; double-click a room → that room expands to focus.

**Locked rooms** render as ghosted outlines with a lock icon.
**Unlocked-but-empty rooms** render as outlines with the unlock condition listed.
**Room labels** show owner's name + room type.

### 4.2 Room-focus mode

When the user double-clicks a room (or selects a character), the canvas zooms to that room. Drag-and-drop characters/objects works within the focused room. Other rooms become small pip indicators along the edge so the user can see who's where.

### 4.3 Drag between rooms

Dragging a character to a tile in a *different* room first routes them through doors — emits a `move(room_id, x, y)` verb call instead of just `move(x, y)`. For the prototype, the routing animation can be a fade-out/fade-in (no per-hallway animation needed).

---

## 5. Server-side changes

### 5.1 `building.js` (new module)

Mirrors `objects-registry.js`:

- Loads from `$WORKSPACE/building.json`.
- Seeds the default 2-apartment-1-hallway layout if missing.
- API: `getRoom(id)`, `listRooms()`, `unlockRoom(id, reason)`, `addRoom(spec)`, `nearbyRooms(id, hops)`.
- Emits perception events on changes.

### 5.2 Position migration

Existing characters in `characters/*.json` have `position: { x, y }`. On bridge boot, a one-time migration:

```js
for (const c of allCharacters) {
  if (!c.position?.room_id) {
    c.position = { room_id: 'apt-1B', x: c.position.x, y: c.position.y }
  }
}
```

(Default to `apt-1B` — the player apartment — for any character without a room. They'll move out as the storyteller assigns them.)

### 5.3 Move verb

`gm.js`'s `move` verb gets an optional `room_id` arg:

```js
move: {
  args: {
    x: { type: "number", required: true },
    y: { type: "number", required: true },
    room_id: { type: "string", required: false },  // defaults to current room
  },
  effects: ["agent.position"],
  prompt: "walk to a tile, optionally in another room (uses doors)",
  ...
}
```

If `room_id` is omitted or matches current, it's a same-room move (existing behavior). If different, the GM resolves a path through doors and emits `move_through_door` perception events for any characters in intermediate rooms.

### 5.4 Scenes

The [scenes.js](../../agent-sandbox/pi-bridge/scenes.js) proximity check changes:

- Two characters are scene-mates only if `room_id` matches AND tile distance ≤ `SCENE_RADIUS` (current rule, restricted to same room).
- A new variant `roomMatesOf(snapshot, pubkey)` returns everyone in the same room regardless of distance — for cards that need "everyone in the kitchen" not "within 3 tiles."

### 5.5 Object placement

Objects get `room_id` in their persisted form. The `nearbyObjects` block in the user-turn prompt filters to the character's current room by default; cards can override.

---

## 6. Migration strategy

The change is large. Roll it in three phases:

### Phase A — schema only, no UI change
- `building.js` exists, default layout seeded.
- Characters and objects gain `room_id` (defaulting all to a single `default` room).
- The big-grid renderer still works against `room_id: 'default'`.
- Tests: nothing should break; one `default` room contains everything.

### Phase B — multi-room rendering
- New `BuildingCanvas.jsx` replaces the single grid for new workspaces.
- Old workspaces keep `default` and render as a single room (compatibility).
- Drag-and-drop and click-to-move work within rooms.

### Phase C — unlocks + cross-room movement
- Locked rooms render and unlock on conditions.
- `move(room_id, x, y)` verb supports cross-room movement.
- Card frontmatter gains `room:` and `room_unlock:` keys.
- Object purchase unlocks shared rooms.

Phase A is safe and additive. Phase B is the visible change. Phase C is content/affordance work.

---

## 7. What this enables

Once the building is in:

- **Day 1's "I inherited a stranger's room" moment** is real — the room exists with state before the player spawns.
- **Per-character apartments** as customization surfaces — gifting a houseplant to *Marisol's apartment* (not the world).
- **Communal vs. private** rooms — eavesdropping is "Mara was in the lobby; Tomek was in his apartment talking on the phone; Marisol was in the kitchen and could just hear them through the wall."
- **Spatial scene gating** — "this card requires 2 people in the kitchen and 1 person in the hallway."
- **Room-as-character** — Mara's apartment can be its own narrative entity (the cluttered desk, the photo on the windowsill — surfaced in cards).

---

## 8. What this doesn't change

- Tile-based movement within a room — same model.
- Smart-object verb registry — same.
- Moodlets, threads, arcs, loops — same.
- The building is a single Colyseus state object; we're not multi-instancing rooms (defer until [#205 storage scale-out](../../tasks/205-agent-sandbox-storage-scaleout-phase1.md)).

---

## 9. Open questions

1. **Inter-room visibility through windows.** Animal Crossing villagers can see each other across windows. Marisol overhearing Carlos's phone call requires this. Cheapest implementation: each apartment has a `window_to: hallway` flag, and a `nearby` query can include `1 window-hop` as a soft adjacency. Defer to phase C with a stub flag now.
2. **How does the LLM perceive rooms?** Add a "rooms in the building" block to the system prompt? My take: only describe the character's *current* room and adjacent rooms. The full layout is metadata, not character knowledge.
3. **Sleeping / privacy norms.** When a character is "in their apartment with the door closed", do other characters' scene checks still see them? Sims handles this with privacy modifiers; we'd add a `door_state: open|closed` tile flag.
4. **Building size limits.** When does the building stop growing? My take: 8 apartments + 4 communal rooms + outdoor. Beyond that we're talking about a different game shape.
5. **Visual style** of the building canvas. Top-down vs. cross-section vs. side-on. Tomodachi is cross-section; the Sims is top-down; AC is top-down 3D. Side-on cross-section reads most legibly at small scale; let's mock both before committing.

---

## 10. Implementation order

Slice plan inside [#285](../../tasks/285-multi-room-building.md):

1. `building.js` module + default layout + position migration (phase A).
2. Bridge HTTP endpoints `GET /building`, `GET /rooms/:id`, `POST /rooms/:id/unlock` (admin).
3. Multi-room scene/proximity logic (`roomMatesOf`).
4. `BuildingCanvas.jsx` UI replacing `RoomMap.jsx` (phase B).
5. Cross-room `move` verb + door routing (phase C).
6. Card frontmatter `room:` + `room_unlock:` keys + runtime.
7. Inter-room window stub for eavesdropping (phase C+).

Phases A and B are the prototype-able floor. Phase C unlocks the audience-promised "the building grows" moment.

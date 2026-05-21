/**
 * Demo / trailer scenario orchestration.
 *
 * Composes the building-tier system, the room-placement primitive,
 * the agent roster, and the camera bus to drop the shelter into a
 * "fully populated 25-floor tower with workers" state suitable for
 * trailer capture. Every action it takes goes through the same
 * surface the regular game uses — `setBuildingTier`, `addBuiltRoom`,
 * `addAgent`, `panCameraTo` — so there's no demo-only side path.
 *
 * Reusable for testing scenarios too: a future load-test could call
 * `populateDemo({ tier: 5, agentsPerRoom: 2 })` to fill the shelter
 * before running scenario probes.
 */
import config from '../config.js'
import { panCameraTo } from './shelterStageBus.js'
import { xpAtLevel } from './shelterStore/store.js'
import { MANAGER_KEY } from './shelterStore/index.js'
import { refresh as refreshGeneratedRoomTypes } from './generatedRoomTypes.js'

// Player level seeded by the demo. High enough that collecting room
// rewards during the trailer doesn't immediately trigger a level-up.
const DEMO_PLAYER_LEVEL = 50

// Demo-specific column footprint — decoupled from the gameplay tier
// curve so the trailer scenario isn't pinned to whichever player-
// facing tier the curve says. Stepped silhouette: two 15-floor
// columns above the original ground row, plus a 3rd column on the
// right that only reaches floor 5 ("first 5 floors 3 rooms wide").
// `maxFloor` controls how tall the column is (and therefore which
// floors are buildable); `prefillMaxFloor` controls how many of those
// floors the demo seeds with rooms. The 3rd column has two extra
// buildable floors above its prefilled stack so the player can build
// on them during the demo.
const DEMO_COLUMNS = [
  { gridX: 0, gridW: 2, maxFloor: 15 },
  { gridX: 2, gridW: 2, maxFloor: 15 },
  { gridX: 4, gridW: 2, maxFloor: 6, prefillMaxFloor: 5 },
]
// One demo agent every Nth room. With ~36 demo rooms a stride of 3
// produces ~12 agents — enough to feel populated, light enough not
// to choke the render during the cinematic.
const DEMO_AGENT_STRIDE = 1
const DEMO_MAX_AGENTS = 18

const BRIDGE_URL = config.agentSandbox?.bridgeUrl || ''

// ─── Bridge data ────────────────────────────────────────────────────

async function fetchAddedRoomTypes() {
  if (!BRIDGE_URL) return []
  try {
    const r = await fetch(`${BRIDGE_URL}/room-layouts`)
    if (!r.ok) return []
    const j = await r.json()
    return (j.rooms || []).filter((x) => x.status === 'added' && (x.propCount || 0) > 0)
  } catch { return [] }
}

async function fetchRiggedCharacters() {
  if (!BRIDGE_URL) return []
  try {
    const r = await fetch(`${BRIDGE_URL}/characters`)
    if (!r.ok) return []
    const j = await r.json()
    // `added` is the curator's gate — only approved characters join the
    // live pool. We trust the curator to have verified the rig is on
    // disk before flipping the flag (the AgentProfile checkbox sits
    // next to the rig preview, so this is hard to miss).
    //
    // Don't filter by `c.model` here — that field is the LLM model id
    // (Claude/Gemma/etc.), not the 3D rig URL, and most demo characters
    // won't have an LLM assigned.
    return (j.characters || []).filter((c) => !!c.added)
  } catch { return [] }
}

// ─── Slot enumeration (mirror of ShelterStage3D's deriveDefaultSlots) ─

function deriveSlots(columns) {
  const slots = []
  for (const col of columns) {
    // Prefill stops at `prefillMaxFloor` when set so the top floors
    // stay empty and buildable; otherwise we fill up to `maxFloor`.
    const top = col.prefillMaxFloor ?? col.maxFloor
    for (let y = 0; y <= top; y++) {
      slots.push({ gridX: col.gridX, gridY: y, gridW: col.gridW, gridH: 1 })
    }
  }
  return slots
}

// ─── Populate ───────────────────────────────────────────────────────

/**
 * Fill the shelter to the highest tier with rooms cycling through the
 * "added" room library, then assign one rigged character per room.
 * Idempotent — re-running clears the previous demo state first.
 */
export async function populateDemo(storeApi, {
  columns = DEMO_COLUMNS,
  agentStride = DEMO_AGENT_STRIDE,
  maxAgents = DEMO_MAX_AGENTS,
  baseLayoutRooms = null,
} = {}) {
  // Clean slate. Drops player-built rooms + any prior demo agents.
  cleanupDemo(storeApi)

  // Seed player XP to level DEMO_PLAYER_LEVEL so the first reward
  // collection during the trailer doesn't trigger an immediate level-up.
  storeApi.setPlayerXp(xpAtLevel(DEMO_PLAYER_LEVEL))

  // Set the building's column footprint directly — bypasses the tier
  // curve so the demo can have a stepped silhouette (e.g., 2 columns
  // of 15 floors + a 3rd column of 5).
  storeApi.setColumns(columns)

  // Resolve the ground-floor layout rooms if the caller didn't pass
  // them — same source ShelterStage3D reads (the static layout JSON).
  if (!baseLayoutRooms) {
    try {
      const r = await fetch('/shelter-layout.json')
      if (r.ok) baseLayoutRooms = (await r.json()).rooms ?? []
    } catch { baseLayoutRooms = [] }
  }

  // Prime the generated-room registry so getRoomType('gen:<id>') can
  // resolve work fields (isWork / productionDuration / rewards) during
  // the work tick. Without this, the registry stays empty until the
  // build carousel opens and the demo rooms never produce.
  const [types, chars] = await Promise.all([
    fetchAddedRoomTypes(),
    fetchRiggedCharacters(),
    refreshGeneratedRoomTypes(),
  ])
  if (!types.length) {
    console.warn('[demoMode] no added room types on bridge — nothing to place')
    return
  }
  if (!chars.length) {
    console.warn('[demoMode] no rigged characters on bridge — rooms will be empty')
  }

  // 1) Build a set of positions already filled by layout rooms so we
  // don't try to place a built room over the lobby / pattern-sorting.
  const layoutFilled = new Set(
    (baseLayoutRooms || []).map((r) => `${r.gridX},${r.gridY}`),
  )

  // 2) Place rooms in every column slot that isn't a layout room,
  // cycling through the type library.
  //
  // Stagger production durations by floor — ground floor takes 10
  // real seconds to fill, each floor higher adds another 10. The sim
  // runs at 4 sim-minutes per real-second, so 10 real sec = 40 sim-min.
  const slots = deriveSlots(columns)
  const SIM_MIN_PER_REAL_SEC = 4
  const REAL_SEC_PER_FLOOR = 10
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    if (layoutFilled.has(`${slot.gridX},${slot.gridY}`)) continue
    const type = types[i % types.length]
    const id = `demo-room-${slot.gridX}-${slot.gridY}`
    storeApi.addBuiltRoom({
      id,
      type: `gen:${type.id}`,
      name: type.name || type.id,
      category: 'work',
      kind: 'generated',
      layoutId: type.id,
      gridX: slot.gridX, gridY: slot.gridY,
      gridW: slot.gridW, gridH: slot.gridH,
      color: '#9aa3b0',
    })
    const realSec = (slot.gridY + 1) * REAL_SEC_PER_FLOOR
    const productionDuration = realSec * SIM_MIN_PER_REAL_SEC
    storeApi.upsertRoom(id, { productionDuration })
  }

  // ── Underground demo rooms (Crack cinematic payoff) ──────────────
  // The dirt fill in the stage conceals everything below y=0 until
  // the Crack cinematic punches holes through it. We seed amber-toned
  // rooms a couple of floors deep so when those holes open the player
  // glimpses real built rooms — a hidden subterranean wing rather
  // than just empty earth.
  const undergroundType = types[0] ?? null
  if (undergroundType) {
    const amberPalette = ['#d97a2a', '#e89545', '#f0b265', '#c66220', '#f4c878']
    const undergroundSlots = []
    for (let y = -1; y >= -3; y--) {
      for (const col of columns) {
        undergroundSlots.push({
          gridX: col.gridX, gridY: y,
          gridW: col.gridW, gridH: 1,
        })
      }
    }
    undergroundSlots.forEach((slot, k) => {
      const id = `demo-underground-${slot.gridX}-${slot.gridY}`
      storeApi.addBuiltRoom({
        id,
        type: `gen:${undergroundType.id}`,
        name: 'Amber Chamber',
        category: 'work',
        kind: 'generated',
        layoutId: undergroundType.id,
        gridX: slot.gridX, gridY: slot.gridY,
        gridW: slot.gridW, gridH: slot.gridH,
        color: amberPalette[k % amberPalette.length],
      })
    })
  }

  // 2) Spawn rigged characters across rooms. Two stages:
  //   a) Pinned placements — specific named characters into specific
  //      themed rooms (e.g. nina → tape library, mika → break den) so
  //      the trailer always frames the same cast in the same spaces.
  //   b) Remaining characters are dealt across the rest of the rooms
  //      round-robin by column so all three columns get populated
  //      instead of filling the left column top-to-bottom first.
  const allRooms = [
    ...baseLayoutRooms,
    ...(storeApi.getSnapshot().builtRooms ?? []),
  ]
  const matches = (room, needle) => {
    const haystack = `${room?.name ?? ''} ${room?.layoutId ?? ''} ${room?.id ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  }
  const findRoom = (needle) => allRooms.find((r) => matches(r, needle))
  const findChar = (needle) => chars.find((c) => {
    const haystack = `${c.name ?? ''} ${c.id ?? ''} ${c.pubkey ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })

  const placeAgent = (room, char) => {
    // Include the character's pubkey in the id so two characters can
    // share a room without colliding (used by the nina-in-mika's-room
    // diagnostic placement).
    const charKey = (char.pubkey ?? char.id ?? char.name ?? 'anon').slice(0, 8)
    storeApi.addAgent({
      id: `demo-agent-${room.id}-${charKey}`,
      name: char.name ?? char.pubkey.slice(0, 8),
      pubkey: char.pubkey,
      pos: { roomId: room.id, localU: 0.5, localV: 0.5 },
      // Manually-assigned room so the resolver sticks them in place
      // rather than scheduling them off to wellness.
      manualAssignment: { roomId: room.id },
      assignment: { roomId: room.id },
      // scheduleId stays null — manualAssignment wins. llmEnabled
      // off so we don't fire LLM turns during the trailer capture.
      llmEnabled: false,
      state: 'work',
    })
  }

  const usedRoomIds = new Set()
  const usedCharKeys = new Set()
  let placed = 0

  // Room needles match by case-insensitive substring against
  // `${name} ${layoutId} ${id}`. Use a room id like `demo-room-4-4`
  // to pin to a specific instance when the same room type tiles
  // across multiple cells.
  const pinned = [
    { needleChar: 'nina', needleRoom: 'demo-room-4-4' },
    { needleChar: 'mika', needleRoom: 'mid-century break' },
  ]
  // Pair bonds seeded for the trailer's character beats. Resolved
  // against `chars` by case-insensitive substring on name/id/pubkey.
  const demoPairBonds = [
    { a: 'jeremias vasquez', b: 'elina ribeiro', score: 40 },
  ]
  for (const { needleChar, needleRoom } of pinned) {
    if (placed >= maxAgents) break
    const room = findRoom(needleRoom)
    const char = findChar(needleChar)
    if (!room || !char) {
      console.warn(
        `[demoMode] pinned placement skipped — char "${needleChar}" ${char ? 'ok' : 'missing'}, room "${needleRoom}" ${room ? 'ok' : 'missing'}`,
      )
      if (!room) {
        console.warn(
          '[demoMode] available rooms:',
          allRooms.map((r) => ({ id: r.id, name: r.name, layoutId: r.layoutId })),
        )
      }
      continue
    }
    placeAgent(room, char)
    console.log(
      `[demoMode] pinned ${char.name ?? char.pubkey?.slice(0, 8)} → ${room.id} (${room.name})`,
    )
    // Seed Mika's manager bond at 40 so the demo's chat beat has a
    // headroom to drop from when the Johnny line lands.
    if (needleChar === 'mika' && char.pubkey) {
      storeApi.setRelationship?.(char.pubkey, MANAGER_KEY, 40)
    }
    usedRoomIds.add(room.id)
    usedCharKeys.add(char.pubkey)
    placed += 1
  }

  // Seed pair bonds between non-manager characters (e.g. Jeremias ↔
  // Elena at 40 so Elena's "reach bond 40 with Jeremias" dossier
  // entry is already eligible during the demo). Both characters
  // must be present in the bridge roster, even if neither was
  // pinned — we look them up directly via findChar.
  for (const { a, b, score } of demoPairBonds) {
    const charA = findChar(a)
    const charB = findChar(b)
    if (!charA || !charB) continue
    storeApi.setRelationship?.(charA.pubkey, charB.pubkey, score)
  }

  // Budgeted spread: split the remaining agent budget across columns
  // proportional to column height, then sample evenly-spaced floors
  // within each column so the top and bottom of every column both
  // get populated. Without the even spacing the deal was depth-first
  // and stacked everyone on the bottom rows.
  const roomsByColumn = new Map()
  for (const r of allRooms) {
    if (usedRoomIds.has(r.id)) continue
    const col = r.gridX ?? 0
    if (!roomsByColumn.has(col)) roomsByColumn.set(col, [])
    roomsByColumn.get(col).push(r)
  }
  const columnKeys = [...roomsByColumn.keys()].sort((a, b) => a - b)
  for (const col of columnKeys) {
    roomsByColumn.get(col).sort((a, b) => (a.gridY ?? 0) - (b.gridY ?? 0))
  }

  const remaining = chars.filter((c) => !usedCharKeys.has(c.pubkey))
  const budget = Math.min(maxAgents - placed, remaining.length)
  const totalSize = columnKeys.reduce((acc, c) => acc + roomsByColumn.get(c).length, 0) || 1

  // Proportional allotment, with rounding drift fixed up by walking the
  // columns in order.
  const colTarget = new Map()
  let allotted = 0
  for (const col of columnKeys) {
    const t = Math.round(budget * (roomsByColumn.get(col).length / totalSize))
    colTarget.set(col, Math.min(t, roomsByColumn.get(col).length))
    allotted += colTarget.get(col)
  }
  let drift = budget - allotted
  for (const col of columnKeys) {
    if (drift === 0) break
    const cap = roomsByColumn.get(col).length
    const cur = colTarget.get(col)
    if (drift > 0 && cur < cap) {
      colTarget.set(col, cur + 1); drift -= 1
    } else if (drift < 0 && cur > 0) {
      colTarget.set(col, cur - 1); drift += 1
    }
  }

  // For each column, pick N rooms evenly distributed from floor 0 to
  // the top floor. N=1 → middle; N>1 → endpoints + interior spacing.
  const picksByCol = new Map()
  for (const col of columnKeys) {
    const list = roomsByColumn.get(col)
    const n = colTarget.get(col)
    const picks = []
    if (n === 1) picks.push(list[Math.floor(list.length / 2)])
    else if (n > 1) {
      for (let i = 0; i < n; i++) {
        const idx = Math.round((i * (list.length - 1)) / (n - 1))
        picks.push(list[idx])
      }
    }
    picksByCol.set(col, picks)
  }

  // Round-robin deal across columns so all columns gain density at the
  // same rate. agentStride still skips slots when the caller wants a
  // sparser fill.
  const maxPicks = Math.max(0, ...columnKeys.map((c) => picksByCol.get(c).length))
  let charIdx = 0
  let step = 0
  outer: for (let d = 0; d < maxPicks; d++) {
    for (const col of columnKeys) {
      if (placed >= maxAgents) break outer
      if (agentStride > 0 && step++ % agentStride !== 0) continue
      const picks = picksByCol.get(col)
      if (d >= picks.length) continue
      const room = picks[d]
      const char = remaining[charIdx % remaining.length]
      charIdx += 1
      if (!char) break outer
      placeAgent(room, char)
      placed += 1
    }
  }
}

/**
 * Tear down everything `populateDemo` added: built rooms with the
 * `demo-room-` id prefix, agents with the `demo-agent-` prefix, and
 * the elevated building tier. Real player progress is untouched.
 */
export function cleanupDemo(storeApi) {
  const snap = storeApi.getSnapshot()
  for (const id of Object.keys(snap.agents || {})) {
    if (id.startsWith('demo-agent-')) storeApi.removeAgent(id)
  }
  storeApi.clearBuiltRooms()
  // Reset both tier and the column override so the shelter returns
  // to its starter footprint.
  storeApi.setBuildingTier(1)
}

// ─── Cinematic ──────────────────────────────────────────────────────

/**
 * Slow vertical pan from the rooftop down to the ground row, suitable
 * for trailer capture. Holds at the top for a beat, scrolls, holds at
 * the bottom. Stays above ground — there's nothing to see below for
 * the demo scenario.
 */
export async function playTrailerCinematic({
  columns = DEMO_COLUMNS,
  cellH = 1.1,
  scrollMs = 22000,
  preHoldMs = 1500,
  postHoldMs = 1500,
  zoom = 1.0,
} = {}) {
  // Top frame: well above the tallest column so the rooftops sit a
  // little below the top of the viewport at the start.
  const maxFloor = Math.max(0, ...columns.map((c) => c.maxFloor))
  const topY = (maxFloor + 1.5) * cellH
  const bottomY = cellH / 2
  await panCameraTo({ y: topY, zoom, ms: 800 })
  await new Promise((r) => setTimeout(r, preHoldMs))
  await panCameraTo({ y: bottomY, zoom, ms: scrollMs })
  await new Promise((r) => setTimeout(r, postHoldMs))
}

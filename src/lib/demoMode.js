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

// Demo-specific column footprint — decoupled from the gameplay tier
// curve so the trailer scenario isn't pinned to whichever player-
// facing tier the curve says. Stepped silhouette: two 15-floor
// columns above the original ground row, plus a 3rd column on the
// right that only reaches floor 5 ("first 5 floors 3 rooms wide").
const DEMO_COLUMNS = [
  { gridX: 0, gridW: 2, maxFloor: 15 },
  { gridX: 2, gridW: 2, maxFloor: 15 },
  { gridX: 4, gridW: 2, maxFloor: 5 },
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
    for (let y = 0; y <= col.maxFloor; y++) {
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

  const [types, chars] = await Promise.all([
    fetchAddedRoomTypes(),
    fetchRiggedCharacters(),
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
  const slots = deriveSlots(columns)
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    if (layoutFilled.has(`${slot.gridX},${slot.gridY}`)) continue
    const type = types[i % types.length]
    storeApi.addBuiltRoom({
      id: `demo-room-${slot.gridX}-${slot.gridY}`,
      type: `gen:${type.id}`,
      name: type.name || type.id,
      category: 'work',
      kind: 'generated',
      layoutId: type.id,
      gridX: slot.gridX, gridY: slot.gridY,
      gridW: slot.gridW, gridH: slot.gridH,
      color: '#9aa3b0',
    })
  }

  // 2) Spawn rigged characters across rooms, capped at maxAgents so
  // the trailer render stays smooth. Stride controls spacing when
  // there are more rooms than agents.
  const allRooms = [
    ...baseLayoutRooms,
    ...(storeApi.getSnapshot().builtRooms ?? []),
  ]
  let idx = 0
  for (let i = 0; i < allRooms.length; i++) {
    if (agentStride > 0 && i % agentStride !== 0) continue
    if (idx >= maxAgents) break
    const room = allRooms[i]
    const char = chars[idx % chars.length]
    idx += 1
    if (!char) break
    storeApi.addAgent({
      id: `demo-agent-${room.id}`,
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

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useShelterStoreApi } from './useShelterStore.js'
import {
  play as playTutorial,
  reset as resetTutorial,
  subscribe as subscribeTutorial,
  getState as getTutorialState,
} from '../lib/tutorial/runtime.js'
import {
  focusAgent as busFocusAgent,
  exitFocus as busExitFocus,
  walkAgent as busWalkAgent,
  panCamera as busPanCamera,
  walkInAgent as busWalkInAgent,
  cameraTo as busCameraTo,
  clearTutorialOverrides as busClearTutorialOverrides,
  setAgentMotion as busSetAgentMotion,
} from '../lib/shelterStageBus.js'
import {
  start as startAssignmentMode,
  getState as getAssignmentModeState,
} from '../lib/shelterAssignmentMode.js'
import { getState as getBuildModeState } from '../lib/shelterBuildMode.js'

/**
 * Tutorial runtime host hook.
 *
 * Wires the tutorial runtime to the Shelter stage and store: builds
 * the ctx the runtime expects (resolveCharacter / walk / walkIn /
 * focus / camera / clearTutorialOverrides / findStep), fetches the
 * NPC roster lazily so role-targeting actions can resolve before the
 * dev panel has been opened, and exposes a small play / reset API.
 *
 * Inputs:
 *   scripts   — { steps: [...] } step library, typically the bundled
 *               scripts.json. The hook only reads `steps[]`.
 *   bridgeUrl — agent-sandbox bridge URL for character lookup +
 *               anchor-room seeding when walkIn auto-spawns a recruit.
 *
 * Returns:
 *   state      — full runtime state (overlayAlpha, dialog, carousel, …)
 *   isActive   — convenience boolean
 *   play(step) — scrub leftover non-NPC agents, then run the step
 *   playById(id) — same, but looks up the step by id from `scripts`
 *   reset()    — abort any in-flight run, clear stage overrides,
 *                wipe non-NPC agents
 *
 * Usage notes:
 *   - The hook is safe to call in multiple components — runtime state
 *     is a singleton — but `play` should generally be called from
 *     one host (the dev panel today) so two callers don't race.
 */
export function useTutorialHost({ scripts, bridgeUrl } = {}) {
  const store = useShelterStoreApi()
  const state = useSyncExternalStore(subscribeTutorial, getTutorialState)

  // NPC roster cache — fed by the bridge so role → pubkey lookups
  // work even when the user hasn't opened the dev panel's NPC tab.
  // Refreshed on mount and exposed for play() to refresh on demand
  // (cheap; one HTTP roundtrip).
  const [npcChars, setNpcChars] = useState([])

  const fetchNpcs = useCallback(async () => {
    if (!bridgeUrl) return []
    try {
      const r = await fetch(`${bridgeUrl}/characters?kind=npc`)
      if (!r.ok) return []
      const j = await r.json()
      const list = j.characters ?? []
      setNpcChars(list)
      return list
    } catch { return [] }
  }, [bridgeUrl])

  useEffect(() => { fetchNpcs() }, [fetchNpcs])

  const avatarUrlFor = useCallback((pubkey) => (
    bridgeUrl ? `${bridgeUrl}/characters/${pubkey}/avatar` : null
  ), [bridgeUrl])

  // resolveCharacter — runtime calls this for dialog speaker info and
  // for role-targeted actions. Tries the live store snapshot first,
  // then falls back to the NPC roster cache.
  const resolveCharacter = useCallback(({ role, pubkey } = {}) => {
    const fresh = store.getSnapshot()?.agents ?? {}
    if (pubkey) {
      const live = Object.values(fresh).find((a) => a.pubkey === pubkey)
      if (live) return { name: live.name, pubkey, avatarUrl: avatarUrlFor(pubkey) }
      const c = npcChars.find((x) => x.pubkey === pubkey)
      if (c) return { name: c.name, pubkey, avatarUrl: avatarUrlFor(pubkey) }
    }
    if (role) {
      const live = Object.values(fresh).find((a) => a.role === role && a.pubkey)
      if (live) return { name: live.name, pubkey: live.pubkey, avatarUrl: avatarUrlFor(live.pubkey) }
      const c = npcChars.find((x) => x.npc_role === role)
      if (c) return { name: c.name, pubkey: c.pubkey, avatarUrl: avatarUrlFor(c.pubkey) }
    }
    return null
  }, [store, npcChars, avatarUrlFor])

  // focus — auto-spawns the NPC if not already in the store, then
  // hands off to the stage bus. Mirrors the focusAgent contract from
  // the bus (camera tween + outline + motion swap).
  const focus = useCallback(async (pubkey, opts) => {
    let agent = Object.values(store.getSnapshot()?.agents ?? {}).find((a) => a.pubkey === pubkey)
    if (!agent) {
      const c = npcChars.find((x) => x.pubkey === pubkey)
      if (c) {
        store.addAgent({
          id: `npc-${pubkey.slice(0, 12)}`,
          name: c.name ?? 'Unnamed',
          kind: 'npc',
          pubkey,
          pos: c.npc_default_pos ?? null,
          role: c.npc_role ?? null,
        })
        // Give the avatar factory a beat to mount before the stage
        // tries to focus the (now-existing) handle.
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    const target = Object.values(store.getSnapshot()?.agents ?? {}).find((a) => a.pubkey === pubkey)
    if (target) busFocusAgent(target.id, opts)
  }, [store, npcChars])

  // walkIn — guarantees the requested character is in the store at a
  // valid room before handing off to the stage's off-camera-park-and-
  // walk-in animation. Three branches:
  //   1. Already in store → re-park at the anchor room and clear any
  //      walk/pace state so the resolver doesn't pull them away.
  //   2. In NPC roster → addAgent with the seed position.
  //   3. Not seen yet → bridge fetch by pubkey, then addAgent.
  const walkIn = useCallback(async (pubkey, fromOffsetX, dx, ms) => {
    const fresh = store.getSnapshot()?.agents ?? {}
    const existing = Object.values(fresh).find((a) => a.pubkey === pubkey)

    // Anchor on the receptionist (Edi) → first NPC → first agent
    // with a room. The seed pos is the right edge of the anchor's
    // room; the cinematic moves the wrapper visually to wherever
    // fromOffsetX puts it.
    const liveAgents = Object.values(fresh)
    const anchor = liveAgents.find((a) => a.role === 'receptionist')
                  ?? liveAgents.find((a) => a.kind === 'npc' && a.pos?.roomId)
                  ?? liveAgents.find((a) => a.pos?.roomId)
    const seedPos = anchor?.pos?.roomId
      ? { roomId: anchor.pos.roomId, localU: 0.9, localV: 0.5 }
      : null
    if (!seedPos) {
      console.warn('[useTutorialHost] walkIn: no anchor room found, aborting')
      return
    }

    if (existing) {
      store.updateAgent(existing.id, {
        pos: seedPos,
        walkFrom: null, walkTo: null,
        paceFrom: null, paceTo: null,
        paceMode: null, paceStartedAt: null,
        paceRestUntil: null, paceRestRole: null,
        assignment: null,
        state: 'idle',
      })
    } else {
      let charData = npcChars.find((x) => x.pubkey === pubkey)
      if (!charData && bridgeUrl) {
        try {
          const r = await fetch(`${bridgeUrl}/characters/${pubkey}`)
          if (r.ok) charData = await r.json()
        } catch (err) {
          console.warn('[useTutorialHost] walkIn: bridge fetch failed', err)
        }
      }
      if (!charData) {
        console.warn('[useTutorialHost] walkIn: could not resolve character', pubkey)
        return
      }
      const isNpc = charData.kind === 'npc'
      store.addAgent({
        id: isNpc ? `npc-${pubkey.slice(0, 12)}` : `bridge-${pubkey.slice(0, 12)}`,
        name: charData.name ?? 'Unnamed',
        kind: charData.kind ?? 'player',
        pubkey,
        pos: seedPos,
        role: charData.npc_role ?? null,
        // No scheduleId — the schedule resolver is what scattered
        // earlier hires to wellness-1; for the cinematic we just want
        // them parked at the anchor room until the player drives them.
        llmEnabled: false,
        state: 'idle',
      })
    }
    await busWalkInAgent({ pubkey, fromOffsetX, dx, ms })
  }, [store, npcChars, bridgeUrl])

  // Wipe non-NPC agents so leftover recruits from a prior run don't
  // confuse a fresh tutorial — they'd have stale rooms / state and
  // the cinematic re-parks them awkwardly.
  const scrubNonNpcAgents = useCallback(() => {
    const snap = store.getSnapshot()?.agents ?? {}
    for (const [id, a] of Object.entries(snap)) {
      if (a.kind !== 'npc') store.removeAgent(id)
    }
  }, [store])

  // ctx is rebuilt per play() so the runtime always sees fresh
  // closures (npcChars cache, etc.). Cheap — just object construction.
  const buildCtx = useCallback(() => ({
    resolveCharacter,
    focus,
    walk: (pubkey, dx, dy, ms) => busWalkAgent({ pubkey, dx, dy, ms }),
    walkIn,
    panCamera: (dx, dy, ms) => busPanCamera({ dx, dy, ms }),
    cameraTo: (cameraState, ms) => busCameraTo({ state: cameraState, ms }),
    exitFocus: () => busExitFocus(),
    clearTutorialOverrides: () => busClearTutorialOverrides(),
    setMotion: (pubkey, motion) => busSetAgentMotion({ pubkey, motion }),
    // Read the player's manual assignment for a pubkey — used by
    // awaitAssignment to wait for the player to pick a room.
    getAssignment: (pubkey) => {
      const fresh = store.getSnapshot()?.agents ?? {}
      const a = Object.values(fresh).find((x) => x.pubkey === pubkey)
      return a?.manualAssignment?.roomId ?? null
    },
    // Engage assignment mode for the agent matching `pubkey`. The
    // tutorial uses this to pre-arm the room picker before the player
    // has tapped the Assignment tab — pattern-sorting becomes
    // tappable the moment Edi mentions it.
    startAssignmentMode: (pubkey) => {
      const fresh = store.getSnapshot()?.agents ?? {}
      const agent = Object.values(fresh).find((x) => x.pubkey === pubkey)
      if (!agent?.id) return
      startAssignmentMode(agent.id, ({ agentId, roomId }) => {
        store.setAssignment(agentId, roomId)
      })
    },
    // Polled by the awaitAssignmentMode action so step 3 can block
    // until the player actually engages the Assignment tab. Without
    // this gate the tap-to-advance dialog would consume the tab tap
    // before it reached the tab button.
    isAssignmentModeActive: () => !!getAssignmentModeState().active,
    // Player wallet — used by awaitCollect to detect when the
    // player has tapped a ready room and collected the payout.
    getCash: () => Number(store.getSnapshot()?.cash ?? 0),
    // Used by awaitBuilt — true if any built room (of optional
    // matching type) exists in the store.
    hasBuiltRoom: (type) => {
      const built = store.getSnapshot()?.builtRooms ?? []
      return type
        ? built.some((r) => r.type === type)
        : built.length > 0
    },
    // Build-mode probes for awaitBuildMode + awaitBuildSelection.
    isBuildModeActive: () => !!getBuildModeState().active,
    getBuildSelection: () => getBuildModeState().selectedType ?? null,
    findStep: (id) => (scripts?.steps ?? []).find((s) => s.id === id) ?? null,
  }), [resolveCharacter, focus, walkIn, scripts])

  const play = useCallback(async (step) => {
    // Refresh NPCs once if the cache is empty so role lookups inside
    // the run can hit the bridge data without a per-action fetch.
    if (npcChars.length === 0) await fetchNpcs()
    scrubNonNpcAgents()
    // Reset player-side XP so the tutorial's level-up beat lands
    // cleanly (the first collect crosses the level-1→2 threshold
    // exactly, instead of overshooting from leftover xp).
    if (store.resetPlayerProgress) store.resetPlayerProgress()
    // Snap the map back to the bundled layout (lobby + pattern-
    // sorting) so a tutorial re-run doesn't see leftover Break Rooms
    // or other player builds from the previous pass.
    if (store.clearBuiltRooms) store.clearBuiltRooms()
    // Reset every room's productionTimer / productionReady so the
    // bar starts empty — otherwise a re-run inherits a half-full
    // (or stuck-ready) bar from the previous attempt.
    if (store.resetRoomProduction) store.resetRoomProduction()
    return playTutorial(step, buildCtx())
  }, [npcChars, fetchNpcs, scrubNonNpcAgents, buildCtx, store])

  const playById = useCallback(async (id) => {
    const step = (scripts?.steps ?? []).find((s) => s.id === id)
    if (!step) {
      console.warn(`[useTutorialHost] unknown step "${id}"`)
      return
    }
    return play(step)
  }, [scripts, play])

  const reset = useCallback(() => {
    resetTutorial()
    busClearTutorialOverrides()
    scrubNonNpcAgents()
    if (store.resetPlayerProgress) store.resetPlayerProgress()
    if (store.clearBuiltRooms) store.clearBuiltRooms()
    if (store.resetRoomProduction) store.resetRoomProduction()
  }, [scrubNonNpcAgents, store])

  return { state, isActive: !!state.active, play, playById, reset }
}

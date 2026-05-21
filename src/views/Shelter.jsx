import { useEffect, useState, useSyncExternalStore } from 'react'
import { AnimatePresence } from 'framer-motion'
import ShelterStage3D from './ShelterStage3D.jsx'
import ShelterDebug from './ShelterDebug.jsx'
import ShelterAgentList from './ShelterAgentList.jsx'
import ShelterCharacterCard from './ShelterCharacterCard.jsx'
import ShelterSelectionPortrait from './ShelterSelectionPortrait.jsx'
import ShelterRoomCard from './ShelterRoomCard.jsx'
import ShelterStageActionButton from './ShelterStageActionButton.jsx'
import ShelterInteractionCard from './ShelterInteractionCard.jsx'
import ShelterCharacterDialog from './ShelterCharacterDialog.jsx'
import * as shelterStageBus from '../lib/shelterStageBus.js'
import AgentSandboxFab from '../components/AgentSandboxFab.jsx'
import ShelterBuildCarousel from './ShelterBuildCarousel.jsx'
import ShelterStoryPanel from './ShelterStoryPanel.jsx'
import TutorialOverlay from './TutorialOverlay.jsx'
import ShelterFxLayer from './ShelterFxLayer.jsx'
import CrackCinematicOverlay from './CrackCinematicOverlay.jsx'
import {
  subscribe as subCrackCinematic,
  getState as getCrackCinematic,
} from '../lib/crackCinematic.js'
import { subscribe as subTutorial, getState as getTutorial } from '../lib/tutorial/runtime.js'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { useWorldDrop } from '../hooks/useWorldDrop.js'
import { attachNotesEngineToStore } from '../lib/notesEngine.js'
import { levelForXp, xpAtLevel, MANAGER_KEY } from '../lib/shelterStore/index.js'
import {
  start as startBuildMode,
  cancel as cancelBuildMode,
  subscribe as subBuildMode,
  getState as getBuildMode,
} from '../lib/shelterBuildMode.js'
import { getRoomType } from '../lib/shelterWorld/roomTypes.js'
import { getState as getGeneratedState } from '../lib/generatedRoomTypes.js'

const TABS = [
  { id: 'stage',  label: 'Story',  glyph: '◆' },
  { id: 'build',  label: 'Build',  glyph: '◳' },
  { id: 'agents', label: 'Agents', glyph: '◌' },
]

export default function Shelter() {
  const [tab, setTab] = useState('stage')
  // Story + Agents are overlay toggles that sit on top of the stage,
  // mirroring how Build behaves. Only one overlay (build, story, or
  // agents) is open at a time — opening one closes the others.
  const [storyOpen, setStoryOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  // Demo chat state — when the player sends a message to a focused
  // agent we show an animated ellipsis for ~1.5s then stream in a
  // canned reply. Currently only Mika has a scripted line.
  const [chatPending, setChatPending] = useState(false)
  const [chatLine, setChatLine] = useState(null)
  // Pulses the bond bar red briefly when Mika's bond is reduced.
  const [bondFlashing, setBondFlashing] = useState(false)
  // Transient toast shown below the chat (e.g. "Mika will remember that.").
  const [chatToast, setChatToast] = useState(null)
  const [focused, setFocused] = useState(null)
  const [focusedAgent, setFocusedAgent] = useState(null)
  const [selection, setSelection] = useState(null)
  const tutorial = useSyncExternalStore(subTutorial, getTutorial)
  const crackCinematic = useSyncExternalStore(subCrackCinematic, getCrackCinematic)
  // The character card overlays the lower portion of the stage. We
  // suppress it during a tutorial cinematic by default — but a step
  // can flip `cardVisible: true` (via the `showCard` action) when it
  // explicitly wants the player to see it (e.g. step 3 directs the
  // player at a specific tab).
  const cardSuppressed = tutorial.active && !tutorial.cardVisible
  // Two distinct UIs:
  //   - Selection (single-tap)  → dossier card + 3D portrait + stage
  //                               action button
  //   - Focus    (double-tap or portrait-tap) → interaction card +
  //                               character dialog speech bubble
  // Stays selection-only until the camera is actually zoomed onto
  // the agent; focusedAgent is set by ShelterStage3D when that
  // happens.
  const selectedAgent = selection?.kind === 'agent' ? selection : null
  const isFocused = !!focusedAgent && !cardSuppressed
  const dossierAgent = !isFocused && !cardSuppressed ? selectedAgent : null
  const portraitPubkey = !isFocused && selectedAgent?.pubkey ? selectedAgent.pubkey : null
  // Cash + player XP from the shelter store. Cash floats bottom-left
  // over the stage (out of the status bar so the time can stand on
  // its own), and XP fills a thin bar across the bottom of the
  // screen body so the player always sees their progression.
  const snap = useShelterStore()
  const cash = snap?.cash ?? 0
  const playerXp = snap?.playerXp ?? 0
  const playerLevel = levelForXp(playerXp)
  // Quadratic curve (shelterStore/store.js): leveling cost grows by
  // 100xp each level. Fill bar = position inside current level's range.
  const xpFloor = xpAtLevel(playerLevel)
  const xpCeil = xpAtLevel(playerLevel + 1)
  const xpInLevel = playerXp - xpFloor
  const xpNeeded = xpCeil - xpFloor
  const xpPct = Math.max(0, Math.min(100, (xpInLevel / xpNeeded) * 100))

  // Build-mode state — when active, the Build tab reads as "selected"
  // and the carousel renders. Build is an overlay on the Stage view,
  // not a separate tab pane.
  const buildState = useSyncExternalStore(subBuildMode, getBuildMode)
  const storeApi = useShelterStoreApi()

  // Unified drop handler — same shape as Colony / Sims. Resolves the
  // bridge character from the shared roster, then writes a Shelter
  // agent keyed by the bridge pubkey (idempotent on re-drop).
  const findShelterAgentId = (c) => {
    const snap = storeApi.getSnapshot()
    if (snap.agents?.[c.pubkey]) return c.pubkey
    const hit = Object.values(snap.agents ?? {}).find((a) => a.pubkey === c.pubkey)
    return hit?.id ?? null
  }

  const onDropCharacter = useWorldDrop({
    world: 'Shelter',
    isInstantiated: (c) => !!findShelterAgentId(c),
    spawn: (character, target) => {
      storeApi.addAgent({
        id: character.pubkey,
        name: character.name,
        pubkey: character.pubkey,
        kind: 'employee',
        scheduleId: 'worker',
        pos: { roomId: target.roomId, localU: target.localU, localV: target.localV },
      })
    },
  })

  // Tutorial may pulse the Build tab — surfaces via tutorial state's
  // pulseGameTab field (added below in the runtime).
  const pulseGameTab = tutorial.pulseGameTab ?? null

  const handleTabClick = (id) => {
    if (id === 'stage') {
      // Toggle the story overlay. Close the other overlays so only
      // one is visible at a time.
      if (buildState.active) cancelBuildMode()
      setAgentsOpen(false)
      setStoryOpen((v) => !v)
      setTab('stage')
      return
    }
    if (id === 'agents') {
      if (buildState.active) cancelBuildMode()
      setStoryOpen(false)
      setAgentsOpen((v) => !v)
      setTab('stage')
      return
    }
    if (id === 'build') {
      // Toggle: tap Build while not in mode → start; tap while in
      // mode → cancel. Doesn't change the active tab pane (build is
      // an overlay on the stage).
      if (buildState.active) {
        cancelBuildMode()
      } else {
        setStoryOpen(false)
        setAgentsOpen(false)
        startBuildMode(({ type, gridX, gridY, gridW, gridH }) => {
          // Generated room types (id like "gen:e2e-v5-…") come from the
          // bridge layout registry, not the static ROOM_TYPES catalogue.
          // They route into the layout-dressing pipeline via room.kind.
          const isGen = typeof type === 'string' && type.startsWith('gen:')
          const rt = isGen
            ? getGeneratedState().types.find((t) => t.id === type)
            : getRoomType(type)
          if (!rt) return
          const newRoom = {
            id: `${type}-${Date.now()}`,
            type,
            name: rt.name,
            category: rt.category,
            gridX, gridY, gridW, gridH,
            color: rt.color ?? '#9aa3b0',
            ...(isGen ? { kind: 'generated', layoutId: rt.layoutId, palette: rt.palette } : {}),
          }
          storeApi.addBuiltRoom(newRoom)
          // Celebrate — stage handler projects the room to screen and
          // fires sparkle + popup FX. Fired AFTER addBuiltRoom so the
          // room is already in the scene when the handler runs.
          shelterStageBus.celebrateRoom(newRoom.id)
        })
        setTab('stage')   // make sure the stage canvas is the active pane
      }
      return
    }
  }

  // Reset the chat line whenever the focused agent changes so a
  // scripted reply doesn't leak across characters.
  useEffect(() => {
    setChatPending(false)
    setChatLine(null)
    setBondFlashing(false)
    setChatToast(null)
  }, [focusedAgent?.id])

  const handleChatSend = (msg) => {
    if (!focusedAgent) return
    setChatPending(true)
    setChatLine(null)
    const name = (focusedAgent.name ?? '').toLowerCase()
    const pubkey = focusedAgent.pubkey
    setTimeout(() => {
      setChatPending(false)
      if (name.includes('mika')) {
        setChatLine(
          "What?! What do you mean Johnny is dead?? I can't believe it, "
          + 'I was just in the Archives with him a minute ago!',
        )
        // Beat the dialog with the body language: shock as the line
        // lands, then settle into wary once she's had a moment.
        if (pubkey) {
          shelterStageBus.setAgentMotion({ pubkey, motion: 'shock' })
          setTimeout(() => {
            shelterStageBus.setAgentMotion({ pubkey, motion: 'wary' })
          }, 2600)
          // Bond consequence — drop from 40 → 20 with a red pulse on
          // the bar and a "will remember that" toast under the chat.
          // Slight delay so the audience reads the line first.
          setTimeout(() => {
            storeApi.setRelationship?.(pubkey, MANAGER_KEY, 20)
            setBondFlashing(true)
            setChatToast('Mika will remember that.')
            setTimeout(() => setBondFlashing(false), 1200)
            setTimeout(() => setChatToast(null), 3200)
          }, 900)
        }
      } else {
        // Other characters keep the default acknowledgement until
        // we script their replies.
        setChatLine('Hm?')
      }
    }, 1500)
  }

  // Notes engine — evaluates per-character quest conditions and posts
  // unlocks against the bridge whenever the store mutates. One-shot
  // attach + return the unsubscribe.
  useEffect(() => attachNotesEngineToStore(storeApi), [storeApi])

  // ESC key cancels build mode (third cancel path alongside the X
  // on the carousel and re-tapping the Build tab).
  useEffect(() => {
    if (!buildState.active) return
    const onKey = (e) => { if (e.code === 'Escape') cancelBuildMode() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [buildState.active])
  return (
    <div className="game-view shelter-view">
      <div className="game-phone-frame">
        <div className="game-phone-notch" />
        <div className="game-phone-screen">
          <AgentSandboxFab />
          <div className="game-status-bar">
            <span>9:41</span>
            <span>●●● ▮▮</span>
          </div>
          <div className="game-screen-body">
            {/* Stage stays mounted across tab switches so the WebGL
                context survives — same trick Sims uses. */}
            <div className="game-tab-pane" hidden={tab !== 'stage'}>
              <div className={`shelter-screen-body${crackCinematic.active ? ' is-cracking' : ''}`}>
                <ShelterStage3D
                  onFocusChange={setFocused}
                  onAgentFocusChange={setFocusedAgent}
                  onSelectionChange={setSelection}
                  onDropCharacter={onDropCharacter}
                />
                {/* Room info card at the top — hidden while a character
                    is focused (the interaction card owns that real
                    estate). */}
                {!isFocused && (() => {
                  const id = focused?.id ?? (selection?.kind === 'room' ? selection.id : null)
                  const name = focused?.name ?? (selection?.kind === 'room' ? selection.name : null)
                  return <ShelterRoomCard roomId={id} name={name} />
                })()}
                {/* Selection UI — single-tap state. Dossier card at
                    top, 3D portrait bottom-left (tap it to escalate
                    to focus), reassign/collect button bottom-center. */}
                <AnimatePresence>
                  {dossierAgent && (
                    <ShelterCharacterCard key="card" agent={dossierAgent} />
                  )}
                </AnimatePresence>
                <AnimatePresence mode="wait">
                  {portraitPubkey && (
                    <ShelterSelectionPortrait
                      key={portraitPubkey}
                      pubkey={portraitPubkey}
                      onClick={() => {
                        // eslint-disable-next-line no-console
                        console.log('[portrait-click]', { id: selectedAgent?.id, cardSuppressed, tutorialActive: tutorial.active })
                        if (selectedAgent?.id) shelterStageBus.focusAgent(selectedAgent.id)
                      }}
                    />
                  )}
                </AnimatePresence>
                <AnimatePresence>
                  {portraitPubkey && dossierAgent && (
                    <ShelterStageActionButton key="action" agent={dossierAgent} />
                  )}
                </AnimatePresence>

                {/* Focus UI — double-tap or portrait-tap state.
                    Interaction card replaces the dossier; speech-
                    bubble dialog shows the character acknowledging
                    being approached. */}
                <AnimatePresence>
                  {isFocused && (
                    <ShelterInteractionCard
                      key="interaction"
                      agent={focusedAgent}
                      onClose={() => shelterStageBus.exitFocus()}
                      onSend={handleChatSend}
                      bondFlashing={bondFlashing}
                      toast={chatToast}
                    />
                  )}
                </AnimatePresence>
                <AnimatePresence>
                  {isFocused && (
                    <ShelterCharacterDialog
                      key="dialog"
                      agent={focusedAgent}
                      text={chatLine ?? 'Yes?'}
                      pending={chatPending}
                    />
                  )}
                </AnimatePresence>
                {/* Dev panel — hidden behind a backtick toggle (or the
                    floating "DEV" button) so it stays out of the way for
                    casual viewers but is reachable on prod for adding
                    NPCs / inspecting state. */}
                <ShelterDebug />
                {/* Bottom-left currency indicator — primary player
                    state. Class is also queried by the FX layer to
                    target the cash-fly animation. */}
                <div className="shelter-currency-hud">
                  <span className="shelter-currency-glyph">¤</span>
                  <span className="shelter-currency-value">{cash.toLocaleString()}</span>
                </div>
                {/* Build Mode carousel — slides down from the top
                    when build-mode is active. Overlays the stage. */}
                <ShelterBuildCarousel />
                {/* Story-so-far + Agents overlays — slide down from
                    the top when their bottom-bar tab is toggled on.
                    Same z-band as the build carousel. */}
                <ShelterStoryPanel
                  open={storyOpen}
                  onClose={() => setStoryOpen(false)}
                />
                <div
                  className={`shelter-agents-panel${agentsOpen ? ' visible' : ''}`}
                >
                  <div className="shelter-agents-panel-head">
                    <span className="shelter-agents-panel-title">Agents</span>
                    <button
                      type="button"
                      className="shelter-agents-panel-close"
                      onClick={() => setAgentsOpen(false)}
                      aria-label="Close agents"
                    >×</button>
                  </div>
                  <ShelterAgentList />
                </div>
                {/* Tutorial scrim + dialog box. Sits above the stage
                    but below the dev panel so the panel can still be
                    toggled while a step is paused for input. */}
                <TutorialOverlay />
                {/* Coin-fly + level-up celebration overlay. Mounts
                    transient effects sourced from the FX bus. */}
                <ShelterFxLayer />
                {/* Crack cinematic — the cracks themselves are
                    rendered in-scene via a shader on the dirt-fill
                    mesh. This DOM overlay only carries the dust +
                    vignette + impact flash that should not be
                    yanked around by the camera tween. */}
                {crackCinematic.active && <CrackCinematicOverlay />}
              </div>
            </div>
          </div>
          {/* Player XP bar — sits between the screen body and the
              tab nav so it's always visible regardless of which tab
              is active. Caps at 100% within the current level. */}
          <div className="shelter-xp-bar" title={`Level ${playerLevel} — ${xpInLevel}/${xpNeeded} xp`}>
            <div
              className="shelter-xp-bar-fill"
              style={{ width: `${xpPct}%` }}
            />
            <span className="shelter-xp-bar-label">Lv {playerLevel}</span>
          </div>
          <nav className="game-tab-bar" role="tablist">
            {TABS.map((t) => {
              // Build / Stage(=Story) / Agents are all overlay
              // toggles on top of the stage — each tab reads as
              // active when its overlay is open.
              const isBuildActive = t.id === 'build' && buildState.active
              const isStoryActive = t.id === 'stage' && storyOpen
              const isAgentsActive = t.id === 'agents' && agentsOpen
              const active = isBuildActive || isStoryActive || isAgentsActive
              const isPulsing = pulseGameTab === t.id && !active
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`game-tab${active ? ' active' : ''}${isPulsing ? ' is-pulsing' : ''}`}
                  onClick={() => handleTabClick(t.id)}
                >
                  <span className="game-tab-glyph">{t.glyph}</span>
                  <span className="game-tab-label">{t.label}</span>
                </button>
              )
            })}
          </nav>
        </div>
      </div>
    </div>
  )
}

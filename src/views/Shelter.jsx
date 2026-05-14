import { useEffect, useState, useSyncExternalStore } from 'react'
import { AnimatePresence } from 'framer-motion'
import ShelterStage3D from './ShelterStage3D.jsx'
import ShelterDebug from './ShelterDebug.jsx'
import ShelterAgentList from './ShelterAgentList.jsx'
import ShelterCharacterCard from './ShelterCharacterCard.jsx'
import ShelterSelectionPortrait from './ShelterSelectionPortrait.jsx'
import ShelterRoomCard from './ShelterRoomCard.jsx'
import ShelterStageActionButton from './ShelterStageActionButton.jsx'
import ShelterBuildCarousel from './ShelterBuildCarousel.jsx'
import TutorialOverlay from './TutorialOverlay.jsx'
import ShelterFxLayer from './ShelterFxLayer.jsx'
import { subscribe as subTutorial, getState as getTutorial } from '../lib/tutorial/runtime.js'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { attachNotesEngineToStore } from '../lib/notesEngine.js'
import { levelForXp, xpAtLevel } from '../lib/shelterStore/index.js'
import {
  start as startBuildMode,
  cancel as cancelBuildMode,
  subscribe as subBuildMode,
  getState as getBuildMode,
} from '../lib/shelterBuildMode.js'
import { getRoomType } from '../lib/shelterWorld/roomTypes.js'
import { getState as getGeneratedState } from '../lib/generatedRoomTypes.js'

const TABS = [
  { id: 'stage',  label: 'Stage',  glyph: '◆' },
  { id: 'build',  label: 'Build',  glyph: '◳' },
  { id: 'agents', label: 'Agents', glyph: '◌' },
]

export default function Shelter() {
  const [tab, setTab] = useState('stage')
  const [focused, setFocused] = useState(null)
  const [focusedAgent, setFocusedAgent] = useState(null)
  const [selection, setSelection] = useState(null)
  const tutorial = useSyncExternalStore(subTutorial, getTutorial)
  // The character card overlays the lower portion of the stage. We
  // suppress it during a tutorial cinematic by default — but a step
  // can flip `cardVisible: true` (via the `showCard` action) when it
  // explicitly wants the player to see it (e.g. step 3 directs the
  // player at a specific tab).
  const cardSuppressed = tutorial.active && !tutorial.cardVisible
  // Card shows on both selection (single-tap) and focus (double-tap).
  // The portrait below is the visual differentiator for selection-only.
  const selectedAgent = selection?.kind === 'agent' ? selection : null
  const cardAgent = cardSuppressed ? null : (focusedAgent || selectedAgent)
  // 3D portrait of the selected character — shown only while the
  // camera is zoomed out (i.e., selected but not focused).
  const portraitPubkey = !focusedAgent && selectedAgent?.pubkey ? selectedAgent.pubkey : null
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

  // Tutorial may pulse the Build tab — surfaces via tutorial state's
  // pulseGameTab field (added below in the runtime).
  const pulseGameTab = tutorial.pulseGameTab ?? null

  const handleTabClick = (id) => {
    if (id === 'build') {
      // Toggle: tap Build while not in mode → start; tap while in
      // mode → cancel. Doesn't change the active tab pane (build is
      // an overlay on the stage).
      if (buildState.active) {
        cancelBuildMode()
      } else {
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
        })
        setTab('stage')   // make sure the stage canvas is the active pane
      }
      return
    }
    // Switching to a non-build tab while in build-mode cancels the mode.
    if (buildState.active) cancelBuildMode()
    setTab(id)
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
          <div className="game-status-bar">
            <span>9:41</span>
            <span>●●● ▮▮</span>
          </div>
          <div className="game-screen-body">
            {/* Stage stays mounted across tab switches so the WebGL
                context survives — same trick Sims uses. */}
            <div className="game-tab-pane" hidden={tab !== 'stage'}>
              <div className="shelter-screen-body">
                <ShelterStage3D
                  onFocusChange={setFocused}
                  onAgentFocusChange={setFocusedAgent}
                  onSelectionChange={setSelection}
                />
                {/* Room info card at the top — name, tier, level,
                    multiplier, progress bar. Replaces the previous
                    bottom-center label. */}
                {(() => {
                  const id = focused?.id ?? (selection?.kind === 'room' ? selection.id : null)
                  const name = focused?.name ?? (selection?.kind === 'room' ? selection.name : null)
                  return <ShelterRoomCard roomId={id} name={name} />
                })()}
                {/* Card, portrait, and stage action all animate in
                    and out together as the player selects/deselects.
                    AnimatePresence keeps each component mounted long
                    enough for its exit transition to play. */}
                <AnimatePresence>
                  {cardAgent && (
                    <ShelterCharacterCard key="card" agent={cardAgent} />
                  )}
                </AnimatePresence>
                <AnimatePresence mode="wait">
                  {portraitPubkey && (
                    <ShelterSelectionPortrait key={portraitPubkey} pubkey={portraitPubkey} />
                  )}
                </AnimatePresence>
                <AnimatePresence>
                  {portraitPubkey && cardAgent && (
                    <ShelterStageActionButton key="action" agent={cardAgent} />
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
                {/* Tutorial scrim + dialog box. Sits above the stage
                    but below the dev panel so the panel can still be
                    toggled while a step is paused for input. */}
                <TutorialOverlay />
                {/* Coin-fly + level-up celebration overlay. Mounts
                    transient effects sourced from the FX bus. */}
                <ShelterFxLayer />
              </div>
            </div>
            <div className="game-tab-pane" hidden={tab !== 'agents'}>
              <ShelterAgentList />
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
              // Build-tab "active" state tracks build-mode, not the
              // current tab pane (Build overlays the stage).
              const isBuildActive = t.id === 'build' && buildState.active
              const isStageActive = t.id === 'stage' && tab === 'stage' && !buildState.active
              const isOtherActive = t.id !== 'build' && t.id !== 'stage' && tab === t.id
              const active = isBuildActive || isStageActive || isOtherActive
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

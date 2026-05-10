import { useSyncExternalStore, useEffect, useState } from 'react'
import {
  subscribe as subBuildMode,
  getState as getBuildMode,
  selectType as selectBuildType,
  cancel as cancelBuildMode,
} from '../lib/shelterBuildMode.js'
import { ROOM_TYPES } from '../lib/shelterWorld/roomTypes.js'
import { useShelterStore } from '../hooks/useShelterStore.js'
import { levelForXp } from '../lib/shelterStore/index.js'
import { subscribe as subTutorial, getState as getTutorial } from '../lib/tutorial/runtime.js'
import {
  subscribe as subGenerated,
  getState as getGeneratedState,
  refresh as refreshGenerated,
} from '../lib/generatedRoomTypes.js'

/**
 * Build Mode carousel — slides down from the top of the screen with
 * one card per buildable room type. Cards filtered to:
 *   - defaultBuilt: false (the lobby and pattern-sorting are on by
 *     default, not buildable)
 *   - tier <= playerLevel (locks future content behind progression)
 *
 * Tapping a card calls shelterBuildMode.selectType(id), which arms
 * the stage's ghost cells. Tapping the X cancels mode entirely.
 */
export default function ShelterBuildCarousel() {
  const buildState = useSyncExternalStore(subBuildMode, getBuildMode)
  const tutorial = useSyncExternalStore(subTutorial, getTutorial)
  const pulseBuildCard = tutorial.pulseBuildCard ?? null
  const snap = useShelterStore()
  const playerLevel = levelForXp(snap?.playerXp ?? 0)
  const generated = useSyncExternalStore(subGenerated, getGeneratedState)

  // Re-poll the bridge each time build mode opens so newly generated
  // rooms show up without a page reload.
  useEffect(() => {
    if (buildState.active) refreshGenerated()
  }, [buildState.active])

  // Stay mounted briefly after `active` flips to false so the slide-
  // up exit transition has time to play before unmounting.
  const [mounted, setMounted] = useState(buildState.active)
  useEffect(() => {
    if (buildState.active) { setMounted(true); return }
    if (!mounted) return
    const id = setTimeout(() => setMounted(false), 360)
    return () => clearTimeout(id)
  }, [buildState.active, mounted])

  if (!mounted) return null

  const builtTypes = new Set((snap?.builtRooms ?? []).map((r) => r.type))
  const buildable = Object.values(ROOM_TYPES).filter((t) => (
    t.defaultBuilt === false
    && (t.tier ?? 1) <= playerLevel
  ))

  const onCardClick = (type) => {
    if (builtTypes.has(type.id) && type.id !== 'pattern-sorting') {
      // Already built — for MVP we don't allow duplicates. Future
      // tiers / multi-instance rooms will lift this.
      return
    }
    selectBuildType(type.id)
  }

  return (
    <div className={`shelter-build-carousel${buildState.active ? ' visible' : ''}`}>
      <div className="shelter-build-carousel-head">
        <span className="shelter-build-carousel-title">Build</span>
        <button
          type="button"
          className="shelter-build-carousel-close"
          onClick={cancelBuildMode}
          aria-label="Cancel build"
        >×</button>
      </div>
      {buildable.length === 0 && generated.types.length === 0 ? (
        <p className="shelter-build-carousel-empty">
          No new rooms unlocked yet. Earn xp to unlock more.
        </p>
      ) : (
        <ul className="shelter-build-carousel-list">
          {generated.types.map((t) => {
            const isSelected = buildState.selectedType === t.id
            return (
              <li
                key={t.id}
                className={`shelter-build-card${isSelected ? ' selected' : ''}`}
              >
                <button
                  type="button"
                  className="shelter-build-card-btn"
                  onClick={() => onCardClick(t)}
                >
                  <strong>{t.name}</strong>
                  <div className="shelter-build-card-tags">
                    <span className="shelter-build-card-tag is-generated" style={{ background: '#3a4658', color: '#cfe0f4' }}>
                      Generated
                    </span>
                    <span className="shelter-build-card-tag" style={{ background: '#2c3340', color: '#a8b3c4' }}>
                      {t.gridW}×{t.gridH}
                    </span>
                  </div>
                  {t.description && <p>{t.description}</p>}
                </button>
              </li>
            )
          })}
          {buildable.map((t) => {
            const isSelected = buildState.selectedType === t.id
            const isBuilt = builtTypes.has(t.id)
            const isPulsing = pulseBuildCard === t.id && !isSelected
            return (
              <li
                key={t.id}
                className={`shelter-build-card${isSelected ? ' selected' : ''}${isBuilt ? ' built' : ''}${isPulsing ? ' is-pulsing' : ''}`}
              >
                <button
                  type="button"
                  className="shelter-build-card-btn"
                  onClick={() => onCardClick(t)}
                  disabled={isBuilt}
                >
                  <strong>{t.name}</strong>
                  {/* Type + payout tags up top — players need to see
                      "is this a work room?" + "what does it pay?"
                      before they pick a card. */}
                  <div className="shelter-build-card-tags">
                    <span className={`shelter-build-card-tag is-${t.isWork ? 'work' : 'service'}`}>
                      {t.isWork ? 'Work' : 'Service'}
                    </span>
                    {t.isWork && t.rewardCash != null && (
                      <span className="shelter-build-card-tag is-payout">
                        +¤{t.rewardCash}
                      </span>
                    )}
                    {t.isWork && t.productionDuration != null && (
                      <span className="shelter-build-card-tag is-cycle">
                        {t.productionDuration}m
                      </span>
                    )}
                  </div>
                  {t.description && <p>{t.description}</p>}
                  {isBuilt && <code>Built</code>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {buildState.selectedType && (
        <p className="shelter-build-carousel-hint">
          Tap a glowing cell to place.
        </p>
      )}
    </div>
  )
}

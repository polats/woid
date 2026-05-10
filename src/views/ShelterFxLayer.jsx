import { useEffect, useRef, useState } from 'react'
import { subscribe as subFx } from '../lib/shelterFxBus.js'
import { useShelterStore } from '../hooks/useShelterStore.js'
import { levelForXp } from '../lib/shelterStore/index.js'
import { perksForLevel } from '../lib/shelterLevelPerks.js'

/**
 * Transient effects layer for the Shelter view:
 *   - Cash coins that fly from a collected room toward the cash
 *     counter (`.shelter-currency-hud` in the DOM).
 *   - Level-up celebration banner — subscribes to playerXp and
 *     triggers when the derived level increments.
 *
 * Mounted once inside the Shelter view. No props.
 */
export default function ShelterFxLayer() {
  const [coins, setCoins] = useState([])  // [{ id, amount, fromX, fromY, toX, toY }]
  const [celebration, setCelebration] = useState(null) // { fromLevel, toLevel } | null
  const nextId = useRef(1)
  const layerRef = useRef(null)
  const snap = useShelterStore()
  const playerXp = snap?.playerXp ?? 0
  const level = levelForXp(playerXp)
  const lastLevelRef = useRef(level)

  // Subscribe to FX events. Coin payloads are queued into local
  // state; each coin renders as an absolutely-positioned element
  // and self-destructs after the CSS animation completes.
  useEffect(() => {
    return subFx(({ type, payload }) => {
      if (type === 'flyCash') {
        // Convert page coords from the producer + the cash-counter
        // target rect into LAYER-local coords so the absolute-
        // positioned coin lands in the right place. The layer is
        // positioned over the phone screen body (not the page), so
        // page coords would be off by the phone's inset on the page.
        const layerEl = layerRef.current
        const layerRect = layerEl?.getBoundingClientRect()
        const layerX = layerRect?.left ?? 0
        const layerY = layerRect?.top ?? 0
        const target = document.querySelector('.shelter-currency-hud')
        const r = target?.getBoundingClientRect()
        const targetPageX = r ? r.left + r.width / 2 : window.innerWidth / 2
        const targetPageY = r ? r.top + r.height / 2 : window.innerHeight - 40
        const id = nextId.current++
        setCoins((cs) => [...cs, {
          id,
          amount: payload.amount,
          fromX: payload.fromX - layerX,
          fromY: payload.fromY - layerY,
          toX: targetPageX - layerX,
          toY: targetPageY - layerY,
        }])
        // Reap after the animation duration (matches CSS).
        setTimeout(() => {
          setCoins((cs) => cs.filter((c) => c.id !== id))
        }, 950)
      } else if (type === 'levelUp') {
        setCelebration(payload)
      }
    })
  }, [])

  // Watch player level — emit a synthetic levelUp on the FX bus when
  // the derived level changes. (We do this here rather than from the
  // store so any number of XP sources funnel through one detector.)
  useEffect(() => {
    if (level > lastLevelRef.current) {
      setCelebration({ fromLevel: lastLevelRef.current, toLevel: level })
    }
    lastLevelRef.current = level
  }, [level])

  // Auto-dismiss the celebration. Stays longer when there's a perks
  // payload so the player has time to read the card; otherwise the
  // shorter beat keeps level-ups snappy in normal play.
  useEffect(() => {
    if (!celebration) return
    const perks = perksForLevel(celebration.toLevel)
    const dur = perks.length > 0 ? 5200 : 2400
    const t = setTimeout(() => setCelebration(null), dur)
    return () => clearTimeout(t)
  }, [celebration])

  if (coins.length === 0 && !celebration) return null

  return (
    <div className="shelter-fx-layer" ref={layerRef}>
      {coins.map((c) => (
        <div
          key={c.id}
          className="shelter-fx-coin"
          style={{
            // CSS custom properties drive the @keyframes — start at
            // (fromX, fromY), end at (toX, toY). Animation timing is
            // ease-in for an arcing-toward-the-counter feel.
            '--fx-from-x': `${c.fromX}px`,
            '--fx-from-y': `${c.fromY}px`,
            '--fx-to-x':   `${c.toX}px`,
            '--fx-to-y':   `${c.toY}px`,
          }}
        >
          ¤{c.amount}
        </div>
      ))}
      {celebration && (() => {
        const perks = perksForLevel(celebration.toLevel)
        return (
          <div className="shelter-fx-celebration" role="status">
            <div className="shelter-fx-celebration-card">
              <div className="shelter-fx-celebration-eyebrow">Level Up</div>
              <div className="shelter-fx-celebration-level">
                {celebration.fromLevel} <span>→</span> {celebration.toLevel}
              </div>
              {perks.length > 0 && (
                <div className="shelter-fx-perks">
                  <div className="shelter-fx-perks-eyebrow">New Perks</div>
                  <ul className="shelter-fx-perks-list">
                    {perks.map((p) => (
                      <li key={`${p.type}-${p.id}`} className={`shelter-fx-perk shelter-fx-perk-${p.type}`}>
                        <PerkIcon type={p.type} />
                        <div className="shelter-fx-perk-meta">
                          <strong>{p.name}</strong>
                          {p.description && <p>{p.description}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function PerkIcon({ type }) {
  // A small ink-on-paper glyph chosen per perk type. Rooms get a
  // floor-plan square; future perk types (decor, agent role, etc.)
  // can pick their own icon and share the .shelter-fx-perk-icon
  // box treatment.
  if (type === 'room') {
    return (
      <svg className="shelter-fx-perk-icon" viewBox="0 0 24 24" width="22" height="22"
        fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="1.5" />
        <path d="M3 14h7v7" />
      </svg>
    )
  }
  return null
}

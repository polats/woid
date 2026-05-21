import { useEffect, useRef, useState } from 'react'
import { subscribe as subFx, emit as emitFx } from '../lib/shelterFxBus.js'
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
  const [popups, setPopups] = useState([])  // [{ id, amount, x, y }]
  const [builds, setBuilds] = useState([])  // [{ id, x, y, sparks: [{ angle, dist }] }]
  const [counterBump, setCounterBump] = useState(0)  // increment to retrigger pulse
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
        // Burst spread — coins fan out from the room before homing
        // toward the counter. Each coin gets a slight random horizontal
        // offset on its origin and a small per-coin delay so they don't
        // depart in one indistinguishable blob.
        const burstIndex = payload.burstIndex ?? 0
        const burstTotal = payload.burstTotal ?? 1
        const spread = burstTotal > 1
          ? (burstIndex / (burstTotal - 1) - 0.5) * 80  // ± 40px horizontal
          : 0
        const jitterY = (Math.random() - 0.5) * 20
        const delay = burstIndex * 55  // ms — stagger
        const duration = 950 + burstIndex * 25
        setCoins((cs) => [...cs, {
          id,
          amount: payload.amount,
          showAmount: payload.showAmount !== false,
          fromX: payload.fromX - layerX + spread,
          fromY: payload.fromY - layerY + jitterY,
          toX: targetPageX - layerX,
          toY: targetPageY - layerY,
          delay,
          duration,
        }])
        // Reap after the animation duration + delay.
        setTimeout(() => {
          setCoins((cs) => cs.filter((c) => c.id !== id))
        }, delay + duration + 50)
        // Counter bump on the FIRST coin's arrival.
        if (burstIndex === 0) {
          setTimeout(() => emitFx('cashBump', {}), delay + duration - 80)
        }
      } else if (type === 'rewardPopup') {
        const layerEl = layerRef.current
        const layerRect = layerEl?.getBoundingClientRect()
        const layerX = layerRect?.left ?? 0
        const layerY = layerRect?.top ?? 0
        const id = nextId.current++
        setPopups((ps) => [...ps, {
          id,
          amount: payload.amount,
          x: payload.fromX - layerX,
          y: payload.fromY - layerY,
        }])
        setTimeout(() => {
          setPopups((ps) => ps.filter((p) => p.id !== id))
        }, 1200)
      } else if (type === 'cashBump') {
        setCounterBump((n) => n + 1)
      } else if (type === 'roomBuilt') {
        const layerEl = layerRef.current
        const layerRect = layerEl?.getBoundingClientRect()
        const layerX = layerRect?.left ?? 0
        const layerY = layerRect?.top ?? 0
        const id = nextId.current++
        // Pre-bake spark trajectories so each <span> has a unique
        // angle + distance — CSS-only fanout via per-element vars.
        const SPARK_COUNT = 12
        const sparks = Array.from({ length: SPARK_COUNT }, (_, i) => {
          const angle = (i / SPARK_COUNT) * Math.PI * 2 + Math.random() * 0.3
          const dist = 60 + Math.random() * 50
          return {
            dx: Math.cos(angle) * dist,
            dy: Math.sin(angle) * dist,
            delay: Math.random() * 80,
          }
        })
        setBuilds((bs) => [...bs, {
          id,
          x: payload.fromX - layerX,
          y: payload.fromY - layerY,
          sparks,
        }])
        setTimeout(() => {
          setBuilds((bs) => bs.filter((b) => b.id !== id))
        }, 1400)
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

  // Apply / clear a CSS class on the cash counter to trigger its
  // scale-bump animation. Using a class toggle (rather than restyling
  // the layer) keeps the bump in the existing currency-hud lane.
  useEffect(() => {
    if (counterBump === 0) return
    const el = document.querySelector('.shelter-currency-hud')
    if (!el) return
    el.classList.remove('is-bumping')
    // Force a reflow so the class re-add restarts the animation.
    void el.offsetWidth
    el.classList.add('is-bumping')
    const t = setTimeout(() => el.classList.remove('is-bumping'), 500)
    return () => clearTimeout(t)
  }, [counterBump])

  // Layer stays mounted at all times so layerRef.current is valid
  // when an event fires — otherwise the FIRST coin of a fresh burst
  // computes its coords against a null layerRect and flies offscreen
  // (page-absolute coords instead of layer-local). Once mounted, all
  // 7 coins in the burst get the same correct origin.
  return (
    <div className="shelter-fx-layer" ref={layerRef}>
      {coins.map((c) => (
        <div
          key={c.id}
          className={`shelter-fx-coin${c.showAmount ? '' : ' is-coin-only'}`}
          style={{
            // CSS custom properties drive the @keyframes — start at
            // (fromX, fromY), end at (toX, toY). Animation timing is
            // ease-in for an arcing-toward-the-counter feel.
            '--fx-from-x': `${c.fromX}px`,
            '--fx-from-y': `${c.fromY}px`,
            '--fx-to-x':   `${c.toX}px`,
            '--fx-to-y':   `${c.toY}px`,
            '--fx-delay':  `${c.delay ?? 0}ms`,
            '--fx-duration': `${c.duration ?? 950}ms`,
          }}
        >
          {c.showAmount ? `¤${c.amount}` : '¤'}
        </div>
      ))}
      {popups.map((p) => (
        <div
          key={p.id}
          className="shelter-fx-reward-popup"
          style={{ left: `${p.x}px`, top: `${p.y}px` }}
        >
          +¤{p.amount}
        </div>
      ))}
      {builds.map((b) => (
        <div
          key={b.id}
          className="shelter-fx-build"
          style={{ left: `${b.x}px`, top: `${b.y}px` }}
        >
          <span className="shelter-fx-build-ring" />
          {b.sparks.map((s, i) => (
            <span
              key={i}
              className="shelter-fx-build-spark"
              style={{
                '--fx-spark-dx': `${s.dx}px`,
                '--fx-spark-dy': `${s.dy}px`,
                '--fx-spark-delay': `${s.delay}ms`,
              }}
            />
          ))}
          <span className="shelter-fx-build-label">BUILT</span>
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

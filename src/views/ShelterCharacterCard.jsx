import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import config from '../config.js'
import { subscribe as subTutorial, getState as getTutorial } from '../lib/tutorial/runtime.js'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { levelForXp, xpAtLevel } from '../lib/shelterStore/index.js'
import { getRoomType } from '../lib/shelterWorld/roomTypes.js'
import { start as startAssignmentMode } from '../lib/shelterAssignmentMode.js'

const cfg = config.agentSandbox || {}

/**
 * Profile card overlay for the focused shelter character.
 *
 * Tabbed: Profile (pic + name + bio) and Schedule (4-slot timetable).
 * Mirrors the agent-sandbox drawer aesthetic — ink-on-paper header,
 * hard 2px borders + 4px shadow, mono uppercase labels.
 *
 * Receives the shape produced by ShelterStage3D's onAgentFocusChange:
 *   { id, pubkey, name, avatarUrl } | null
 *
 * Bio (`about`) and schedule are fetched lazily from the bridge when
 * the agent has a pubkey. Resets on agent change so a fresh load can
 * retry an avatar that previously 404'd.
 */
export default function ShelterCharacterCard({ agent }) {
  const [tab, setTab] = useState('profile')
  const [imgFailed, setImgFailed] = useState(false)
  const [character, setCharacter] = useState(null)
  const [notes, setNotes] = useState(null)
  const [notesIdx, setNotesIdx] = useState(0)
  // Subscribe to the tutorial runtime's pulseTab so step 3 can
  // highlight the Assignment tab without prop-threading from Shelter.
  const tutorial = useSyncExternalStore(subTutorial, getTutorial)
  const pulseTab = tutorial.pulseTab ?? null

  // Live shelter snapshot for the active agent's manualAssignment +
  // the assigned room's production timer, plus the store API for the
  // setAssignment / clearAssignment mutations bound to the buttons.
  const shelterSnap = useShelterStore()
  const shelterApi = useShelterStoreApi()
  const liveAgent = (agent?.id && shelterSnap?.agents?.[agent.id]) || null
  const manualRoomId = liveAgent?.manualAssignment?.roomId ?? null
  const assignedRoom = manualRoomId ? shelterSnap?.rooms?.[manualRoomId] : null
  const assignedRoomType = manualRoomId ? getRoomType(manualRoomId) : null
  const xp = liveAgent?.xp ?? 0
  const level = levelForXp(xp)

  // Tab activation handler — when the player switches INTO the
  // Assignment tab from elsewhere AND the recruit isn't yet
  // assigned, auto-enter selection mode (no extra "Assign" button
  // step). Doesn't re-fire if the player taps the already-active
  // tab so cancels don't loop.
  const handleTabActivate = (id) => {
    setTab(id)
  }

  useEffect(() => { setImgFailed(false); setTab('profile') }, [agent?.id])

  // Fetch /characters/:pubkey → { name, about, ... } so we have the bio.
  // Also re-confirms name in case the registry was stale.
  useEffect(() => {
    if (!agent?.pubkey || !cfg.bridgeUrl) { setCharacter(null); return }
    let cancelled = false
    fetch(`${cfg.bridgeUrl}/characters/${agent.pubkey}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (!cancelled) setCharacter(c) })
      .catch(() => { if (!cancelled) setCharacter(null) })
    return () => { cancelled = true }
  }, [agent?.pubkey])

  // Notes — quest-log page chain. Fetched lazily when the user opens
  // the Notes tab. Re-fetched every 4s while open so unlocks fired by
  // the notes engine show up without a manual refresh.
  useEffect(() => {
    if (tab !== 'notes' || !agent?.pubkey || !cfg.bridgeUrl) return
    let cancelled = false
    const probe = () => {
      fetch(`${cfg.bridgeUrl}/characters/${agent.pubkey}/notes`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (!cancelled && j) setNotes(j) })
        .catch(() => {})
    }
    probe()
    const id = setInterval(probe, 4000)
    return () => { cancelled = true; clearInterval(id) }
  }, [tab, agent?.pubkey])
  // Reset the carousel index when the focused character changes.
  useEffect(() => { setNotesIdx(0); setNotes(null) }, [agent?.id])
  // When new notes arrive, keep the active chip on the latest unlocked
  // page (one before the locked-next, if present).
  useEffect(() => {
    if (!notes) return
    const lastUnlocked = Math.max(0, (notes.pages?.length ?? 1) - 1)
    setNotesIdx(lastUnlocked)
  }, [notes?.pages?.length])

  // Build the chip sequence: unlocked pages + the locked-next (if
  // any) + opaque locked placeholders padding to MIN_CHIPS so the
  // strip always has a consistent silhouette. Locked chips (both the
  // real `next` and the padding) render as lock-only — no title, no
  // condition text — until they unlock.
  const MIN_CHIPS = 5
  const notePages = useMemo(() => {
    const real = [...(notes?.pages ?? [])]
    if (notes?.next) real.push({ ...notes.next, isLocked: true })
    while (real.length < MIN_CHIPS) {
      real.push({
        id: `placeholder-${real.length}`,
        title: null,
        isLocked: true,
        isPlaceholder: true,
      })
    }
    return real
  }, [notes])

  if (!agent) return null

  const display = character?.name || agent.name || agent.id?.slice(0, 8) || '—'
  const initial = (display || '?').slice(0, 1).toUpperCase()
  const showImage = !!agent.avatarUrl && !imgFailed
  const safeIdx = Math.max(0, Math.min(notesIdx, notePages.length - 1))

  // Stars derived from level — 1 star per 4 levels, clamped to 1..5.
  // Gives a stable rarity-tier readout even before a curated `stars`
  // field exists on the character record.
  const starCount = Math.max(1, Math.min(5, Math.ceil(level / 4)))
  // Specialty + personality tags — prefer the bridge's stored fields
  // (set during persona generation); fall back to extracting them from
  // the `about` text for legacy characters that pre-date the structured
  // tag fields.
  let specialty = character?.specialty ?? null
  let personality = character?.personality ?? null
  if (!specialty || !personality) {
    const fromBio = extractPersonaTags(character?.about)
    specialty = specialty ?? fromBio.specialty
    personality = personality ?? fromBio.personality
  }
  // Level XP bar values — same closed-form as the bottom player XP
  // bar so the overlay reads identically across the UI.
  const xpFloor = xpAtLevel(level)
  const xpCeil = xpAtLevel(level + 1)
  const xpInLevel = Math.max(0, xp - xpFloor)
  const xpNeeded = Math.max(1, xpCeil - xpFloor)
  const xpPct = Math.max(0, Math.min(100, (xpInLevel / xpNeeded) * 100))

  return (
    <aside className="shelter-card" role="status" aria-live="polite">
      <header className="shelter-card-head">
        <div className="shelter-card-head-row">
          <div className="shelter-card-avatar">
            {showImage ? (
              <img src={agent.avatarUrl} alt={display} onError={() => setImgFailed(true)} />
            ) : (
              <span>{initial}</span>
            )}
          </div>
          <div className="shelter-card-title">
            <div className="shelter-card-top">
              <div className="shelter-card-xp-bar" title={`Lv ${level} — ${xpInLevel}/${xpNeeded} xp`}>
                <div className="shelter-card-xp-bar-fill" style={{ width: `${xpPct}%` }} />
                <span className="shelter-card-xp-bar-label">Lv {level}</span>
              </div>
              <div className="shelter-card-stars" title={`${starCount}/5`}>
                {Array.from({ length: 5 }, (_, i) => (
                  <span key={i} className={`shelter-card-star${i < starCount ? ' is-filled' : ''}`}>★</span>
                ))}
              </div>
            </div>
            <strong>{display}</strong>
            {(specialty || personality) && (
              <div className="shelter-card-tags">
                {specialty && (
                  <span className="shelter-card-tag is-specialty" title="Specialty">
                    {specialty}
                  </span>
                )}
                {personality && (
                  <span className="shelter-card-tag is-personality" title="Personality">
                    {personality}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="shelter-card-body" role="tabpanel">
        {tab === 'profile' && (
          <AssignmentPanel
            agent={agent}
            character={character}
            manualRoomId={manualRoomId}
            assignedRoom={assignedRoom}
            assignedRoomType={assignedRoomType}
            onCollect={() => {
              if (!manualRoomId) return
              shelterApi.collectRoom(manualRoomId, {
                rewardCash: Number(assignedRoomType?.rewardCash ?? 0),
                rewardXp: Number(assignedRoomType?.rewardXp ?? 0),
                tier: Number(assignedRoomType?.tier ?? 1),
              })
            }}
            onAssign={() => {
              if (!agent?.id) return
              startAssignmentMode(agent.id, ({ agentId, roomId }) => {
                shelterApi.setAssignment(agentId, roomId)
              })
            }}
          />
        )}
        {tab === 'notes' && (
          <NotesPanel
            pages={notePages}
            index={safeIdx}
            onSelect={setNotesIdx}
          />
        )}
      </div>

      <nav className="shelter-card-tabs" role="tablist">
        <CardTab id="profile" tab={tab} setTab={handleTabActivate} pulseTab={pulseTab} title="Profile">
          <IconProfile /><span>Profile</span>
        </CardTab>
        <CardTab id="notes" tab={tab} setTab={handleTabActivate} pulseTab={pulseTab} title="Notes — quest log">
          <IconNotes /><span>Notes</span>
        </CardTab>
      </nav>
    </aside>
  )
}

/**
 * Tab button. Adds an `is-pulsing` class when the tutorial runtime
 * has marked this tab as the one to draw attention to (and the tab
 * isn't already active — once the player opens it, the highlight
 * stops on its own without needing the runtime to clear pulseTab).
 */
function CardTab({ id, tab, setTab, pulseTab, title, children }) {
  const isActive = tab === id
  const isPulsing = pulseTab === id && !isActive
  const cls = [
    'shelter-card-tab',
    isActive ? 'active' : '',
    isPulsing ? 'is-pulsing' : '',
  ].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      className={cls}
      onClick={() => setTab(id)}
      title={title}
    >
      {children}
    </button>
  )
}

function IconProfile() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4.5 5-6.5 8-6.5s6.5 2 8 6.5" />
    </svg>
  )
}

function IconSchedule() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function IconNotes() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="1.5" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  )
}

/**
 * Notes panel — staged folder fold-open per spec A.
 *
 * Three beats:
 *   1. lift     — tapped chip pops up in place (paperclip unlatches)
 *   2. grow     — separately-mounted open card animates from the
 *                 chip's measured rect to the body's full rect
 *   3. page-up  — page body slides up inside the now-fullsize card
 *                 (translateY 100% → 0)
 *
 * Reversed on close. The expanded card inherits the chip's face so
 * the visual identity carries through. Locked chips shake; nothing
 * inside to read.
 */
function NotesPanel({ pages, index, onSelect }) {
  const containerRef = useRef(null)
  const stripRef = useRef(null)
  const chipRefs = useRef({})
  const [openId, setOpenId] = useState(null)
  const [originRect, setOriginRect] = useState(null)
  const [portalTarget, setPortalTarget] = useState(null)
  const [shakeId, setShakeId] = useState(null)
  // Auto-close when the page chain length changes (a new unlock).
  useEffect(() => { setOpenId(null) }, [pages.length])

  // Climb the DOM to the nearest phone-frame screen container so the
  // modal portal renders INSIDE the mock instead of body-level. Falls
  // back to body if we're rendered outside a phone mock (real mobile).
  useEffect(() => {
    let el = containerRef.current
    while (el) {
      if (el.classList?.contains('game-phone-screen')) {
        setPortalTarget(el)
        return
      }
      el = el.parentElement
    }
    setPortalTarget(typeof document !== 'undefined' ? document.body : null)
  }, [])

  // Measure strip overflow for drag constraints. The modal is
  // portalled to body so it sizes from window dimensions instead
  // of a measured target rect.
  const [dragConstraint, setDragConstraint] = useState({ left: 0, right: 0 })
  useEffect(() => {
    const measure = () => {
      const container = containerRef.current
      const strip = stripRef.current
      if (!container || !strip) return
      const cw = container.clientWidth
      const overflow = strip.scrollWidth - cw
      setDragConstraint({ left: -Math.max(0, overflow), right: 0 })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    if (stripRef.current) ro.observe(stripRef.current)
    return () => ro.disconnect()
  }, [pages.length])

  if (!pages || pages.length === 0) {
    return <p className="shelter-card-notes-empty">Loading…</p>
  }
  const openPage = openId ? pages.find((p) => p.id === openId) : null

  const tapChip = (p, i) => {
    onSelect(i)
    if (p.isLocked || p.isPlaceholder) {
      setShakeId(p.id)
      setTimeout(() => setShakeId(null), 360)
      return
    }
    // Measure the chip rect RELATIVE TO THE PORTAL TARGET (the phone
    // screen container, or body as fallback). The modal positions
    // itself inside that container so we don't escape the phone mock.
    const chipEl = chipRefs.current[p.id]
    if (!chipEl || !portalTarget) return
    const cRect = chipEl.getBoundingClientRect()
    const pRect = portalTarget.getBoundingClientRect()
    setOriginRect({
      origin: {
        x: cRect.left - pRect.left,
        y: cRect.top - pRect.top,
        width: cRect.width,
        height: cRect.height,
      },
    })
    setOpenId(p.id)
  }

  const closeOpen = () => setOpenId(null)

  return (
    <div className="shelter-card-notes" ref={containerRef}>
      {/* Strip — drag-x via framer-motion. Tap-vs-drag classification
          is automatic, so chip clicks fire when the user releases
          without dragging past framer-motion's internal threshold. */}
      <motion.div
        ref={stripRef}
        className="shelter-card-notes-strip"
        drag="x"
        dragConstraints={dragConstraint}
        dragElastic={0.08}
        dragMomentum
      >
        {pages.map((p, i) => {
          const isOpen = p.id === openId
          const isActive = i === index && !isOpen
          const isShaking = p.id === shakeId
          return (
            <button
              key={p.id}
              ref={(el) => { chipRefs.current[p.id] = el }}
              type="button"
              data-num={idToTabNumber(p.id)}
              className={[
                'shelter-card-notes-chip',
                isActive ? 'is-active' : '',
                p.isLocked ? 'is-locked' : '',
                p.isPlaceholder ? 'is-placeholder' : '',
                isShaking ? 'is-shaking' : '',
              ].filter(Boolean).join(' ')}
              style={isOpen ? { visibility: 'hidden' } : undefined}
              onClick={() => tapChip(p, i)}
              title={p.isLocked ? '' : (p.title ?? '')}
            >
              {p.isLocked ? (
                p.isPlaceholder ? (
                  // Far-future placeholder — pure lock, no info.
                  <span className="shelter-card-notes-chip-lock" aria-hidden>🔒</span>
                ) : (
                  // Real locked-next page — show the unlock condition
                  // so the player has a visible quest.
                  <>
                    <span className="shelter-card-notes-chip-lock" aria-hidden>🔒</span>
                    <span className="shelter-card-notes-chip-cond">{p.conditionText}</span>
                  </>
                )
              ) : (
                <span className="shelter-card-notes-chip-title">{p.title}</span>
              )}
              <span className="shelter-card-notes-chip-stripe" aria-hidden />
            </button>
          )
        })}
      </motion.div>

      {/* Folder modal — portalled INTO the phone-screen container.
          OpenCard owns its own open + close state machine; we just
          conditionally render it. When it finishes its close
          sequence it calls `onClose` which unmounts. */}
      {openPage && originRect && portalTarget && (
        <OpenCard
          key={openPage.id}
          page={openPage}
          originRect={originRect}
          portalTarget={portalTarget}
          onClose={() => { setOpenId(null); setOriginRect(null) }}
        />
      )}
    </div>
  )
}

/**
 * FolderModal — full-screen manilla-folder reveal.
 *
 * Stages:
 *   anticipate (≈70 ms) — chip shadow hint while modal mounts
 *   grow       (≈260 ms) — folder scales from chip rect to modal size
 *                          with a P5-style overshoot (scale 0.4 → 1.15 → 1.0)
 *   flip       (≈220 ms) — folder cover rotates open (rotateX 0 → -180)
 *                          around the top edge, revealing the inside
 *   reveal     (≈140 ms) — page text fades in with a stamp settle
 *   open       — settled
 *
 * Portal: rendered into document.body so it escapes the character
 * card's overflow:hidden and properly modal-overlays the viewport.
 */
function OpenCard({ page, originRect, portalTarget, onClose }) {
  const [phase, setPhase] = useState('anticipate')

  // Open sequence:  anticipate → grow → flip → reveal → open
  // Close sequence: open → reveal-out → flip-back → shrink → (unmount)
  // Same beats running in reverse, so the player sees the folder
  // un-stamp and re-file. Chip in the strip stays hidden the whole
  // time because `openId` only clears when this component unmounts.
  useEffect(() => {
    const opens = {
      anticipate: ['grow', 60],
      grow:       ['flip', 240],
      flip:       ['reveal', 220],
      reveal:     ['open', 140],
    }
    const closes = {
      'reveal-out': ['flip-back', 140],
      'flip-back':  ['shrink', 220],
      'shrink':     ['done', 280],
    }
    const step = opens[phase] || closes[phase]
    if (!step) return
    if (step[0] === 'done') {
      const t = setTimeout(onClose, step[1])
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setPhase(step[0]), step[1])
    return () => clearTimeout(t)
  }, [phase, onClose])

  // Click handlers — kick off the close sequence; the state machine
  // drives the rest. Ignored while already closing.
  const isClosing = phase === 'reveal-out' || phase === 'flip-back' || phase === 'shrink'
  const handleClose = () => {
    if (isClosing) return
    setPhase('reveal-out')
  }

  // ESC closes.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Modal rect — sized to the PORTAL TARGET (the phone screen
  // container), not the browser viewport. Keeps the modal inside the
  // phone mock with comfortable safe insets on every side.
  const modal = useMemo(() => {
    const rect = portalTarget.getBoundingClientRect()
    const tw = rect.width
    const th = rect.height
    const safeInsetX = Math.max(12, Math.round(tw * 0.05))
    const safeInsetY = Math.max(12, Math.round(th * 0.06))
    const w = Math.min(tw - safeInsetX * 2, 560)
    const h = Math.min(th - safeInsetY * 2, 440)
    return { x: (tw - w) / 2, y: (th - h) / 2, width: w, height: h }
  }, [portalTarget])

  // Origin rect — already in portal-target-relative coords from
  // NotesPanel's measurement.
  const viewportOrigin = originRect.origin
  // Phase predicates — drive the cover/page child animations. Reverse
  // sequence (close) walks these flags backward through false.
  const grown    = phase !== 'anticipate' && phase !== 'shrink'
  const flipped  = phase === 'flip' || phase === 'reveal' || phase === 'open' || phase === 'reveal-out'
  const revealed = phase === 'reveal' || phase === 'open'

  return createPortal(
    <div className="folder-modal-root">
      <motion.div
        className="folder-modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: grown ? 1 : 0 }}
        transition={{ duration: 0.18 }}
        onClick={handleClose}
      />
      {/* Outer motion.div animates position+size; child preserves 3D. */}
      <motion.div
        className="folder-modal"
        initial={{
          x: viewportOrigin.x, y: viewportOrigin.y,
          width: viewportOrigin.width, height: viewportOrigin.height,
        }}
        animate={
          grown
            ? { x: modal.x, y: modal.y, width: modal.width, height: modal.height }
            : { x: viewportOrigin.x, y: viewportOrigin.y, width: viewportOrigin.width, height: viewportOrigin.height }
        }
        transition={{
          x: { type: 'spring', stiffness: 360, damping: 30 },
          y: { type: 'spring', stiffness: 360, damping: 30 },
          width: { type: 'spring', stiffness: 360, damping: 30 },
          height: { type: 'spring', stiffness: 360, damping: 30 },
        }}
        style={{ perspective: '1200px' }}
      >
        <div className="folder-modal-3d">
          {/* Inside of the folder — page body, revealed when the
              cover flips up. */}
          <div className="folder-modal-inside">
            <div className="folder-modal-header">
              <span className="folder-modal-header-title">{page.title}</span>
              <button
                type="button"
                className="folder-modal-close"
                onClick={handleClose}
                aria-label="Close note"
                title="Close"
              >×</button>
            </div>
            <motion.div
              className="folder-modal-page"
              initial={{ opacity: 0, scale: 0.94 }}
              animate={revealed ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.94 }}
              transition={{
                opacity: { duration: 0.18, delay: revealed ? 0.04 : 0 },
                scale: { type: 'spring', stiffness: 360, damping: 28, delay: revealed ? 0.04 : 0 },
              }}
            >
              <div className="folder-modal-page-stamp">FILE {idToTabNumber(page.id)}</div>
              <div className="folder-modal-page-body">{page.body}</div>
            </motion.div>
          </div>
          {/* Cover — the folder's front face. Rotates open on its
              top edge, revealing the inside behind it. */}
          <motion.div
            className="folder-modal-cover"
            initial={{ rotateX: 0 }}
            animate={{ rotateX: flipped ? -176 : 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
          >
            <div className="folder-modal-cover-tab">{idToTabNumber(page.id)}</div>
            <motion.div
              className="folder-modal-cover-title"
              initial={{ opacity: 0 }}
              animate={{ opacity: flipped ? 0 : (grown ? 1 : 0) }}
              transition={{ duration: 0.16, delay: !flipped && grown ? 0.18 : 0 }}
            >
              {page.title}
            </motion.div>
            <div className="folder-modal-cover-stripe" />
          </motion.div>
        </div>
      </motion.div>
    </div>,
    portalTarget,
  )
}

// "p3" → "03", "placeholder-7" → "07", fallback "—".
function idToTabNumber(id) {
  if (!id) return '—'
  const m = String(id).match(/(\d+)/)
  if (!m) return '—'
  return m[1].padStart(2, '0')
}
function AssignmentPanel({
  agent, character, manualRoomId, assignedRoom, assignedRoomType,
  onAssign, onCollect,
}) {
  // Energy + social — 0..100. Bridge always seeds 50/50; persona
  // gameplay can shift them. Falls back to 50 if the bridge response
  // hasn't loaded yet.
  const energy = clampPct(character?.mood?.energy ?? 50)
  const social = clampPct(character?.mood?.social ?? 50)

  const ready = !!assignedRoom?.productionReady
  const reward = Number(assignedRoomType?.rewardCash ?? 0)
  const dur = Number(assignedRoomType?.productionDuration ?? 0)
  const timer = Number(assignedRoom?.productionTimer ?? 0)
  const productionPct = dur > 0 ? Math.min(100, (timer / dur) * 100) : 0

  return (
    <div className="shelter-card-assignment">
      <div className="shelter-card-needs-row">
        <NeedBar label="Energy" pct={energy} kind="energy" />
        <NeedBar label="Social" pct={social} kind="social" />
      </div>

      {manualRoomId ? (
        ready ? (
          <button
            type="button"
            className="shelter-card-reassign-btn is-block is-progress is-collect"
            onClick={onCollect}
            title={`Collect ¤${reward}`}
          >
            <span className="shelter-card-reassign-btn-fill" style={{ width: '100%' }} />
            <span className="shelter-card-reassign-btn-label">Collect · ¤{reward}</span>
          </button>
        ) : (
          <button
            type="button"
            className="shelter-card-reassign-btn is-block is-progress"
            onClick={onAssign}
            title={`Reassign — ${assignedRoomType?.name ?? manualRoomId} · ¤${reward} · ${Math.round(productionPct)}%`}
          >
            <span className="shelter-card-reassign-btn-fill" style={{ width: `${productionPct}%` }} />
            <span className="shelter-card-reassign-btn-label">
              <span className="shelter-card-reassign-btn-primary">Reassign</span>
              <span className="shelter-card-reassign-btn-sub">
                {(assignedRoomType?.name ?? manualRoomId)} · ¤{reward}
              </span>
            </span>
          </button>
        )
      ) : (
        <button
          type="button"
          className="shelter-card-reassign-btn is-block"
          onClick={onAssign}
          disabled={!agent?.id}
        >
          Pick room
        </button>
      )}
    </div>
  )
}

/**
 * Pull `{ specialty, personality }` from a persona-format bio:
 *   "<age clause>. <role/specialty>. <appearance>. <personality>"
 * Returns nulls when the bio doesn't have enough segments. Trims and
 * truncates each tag to keep the chip width sane.
 */
function extractPersonaTags(about) {
  if (typeof about !== 'string' || !about.trim()) return { specialty: null, personality: null }
  // Split on sentence boundaries while ignoring decimal points / commas.
  const segs = about
    .split(/\.\s+|(?<=[a-z])\.$/i)
    .map((s) => s.trim())
    .filter(Boolean)
  if (segs.length < 2) return { specialty: null, personality: null }
  const specialty = trimTag(segs[1])
  const personality = segs.length >= 4 ? trimTag(segs[segs.length - 1]) : null
  return { specialty, personality }
}

function trimTag(s) {
  if (!s) return null
  const cleaned = s.replace(/^\s*(a|an|the)\s+/i, '').trim()
  if (cleaned.length > 26) return cleaned.slice(0, 24).trim() + '…'
  return cleaned
}

function clampPct(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 50
  return Math.max(0, Math.min(100, Math.round(n)))
}

function NeedBar({ label, pct, kind }) {
  return (
    <div
      className={`shelter-card-need-bar shelter-card-need-${kind}`}
      title={`${label} — ${pct}/100`}
    >
      <div className="shelter-card-need-bar-fill" style={{ width: `${pct}%` }} />
      <span className="shelter-card-need-bar-label">{label}</span>
      <span className="shelter-card-need-bar-value">{pct}</span>
    </div>
  )
}

function IconAssignment() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="1.5" />
      <path d="M9 9h6M9 13h6M9 17h4" />
    </svg>
  )
}

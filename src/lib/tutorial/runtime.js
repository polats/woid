/**
 * Tutorial runtime — interprets a step (sequence of actions) and emits
 * UI state via a small event-emitter store. The Shelter view subscribes
 * via `useTutorial()` to render the overlay (black scrim, dialog box,
 * tap-to-advance chevron) and toggle hud visibility.
 *
 * Actions:
 *   { type: "hideHud" }                              hide the phone-frame chrome (status + tab bar)
 *   { type: "showHud" }                              restore it
 *   { type: "setOverlay", alpha: 0..1 }              set the black-overlay opacity instantly
 *   { type: "fadeOverlay", to: 0..1, ms: number }    tween it
 *   { type: "delay", ms: number }                    sleep
 *   { type: "dialog", speakerRole: string,
 *                     text: string,
 *                     tapToAdvance?: bool }          show a speaker portrait + text;
 *                                                    blocks until the user taps if tapToAdvance
 *   { type: "parallel", actions: Action[] }         run a list of actions concurrently; resolves
 *                                                    when all of them finish
 *
 * Actor-targeting actions. The `target` selector resolves to a pubkey
 * via resolveTarget(): `"hired"` (the most-recently-Hired carousel
 * agent), `{ pubkey }`, or `{ role }` (looked up via ctx.resolveCharacter).
 *   { type: "walkAgent", target,
 *           dx?, dy?, ms? }                         animate the matched agent along (dx,dy) over
 *                                                    `ms` while playing the walk motion
 *   { type: "walkInAgent", target,
 *           fromOffsetX?, dx?, ms? }                 park the matched agent at fromOffsetX off-
 *                                                    camera, then walk dx units in
 *   { type: "focusAgent", target,
 *           outline?, motion?, closeup?, ms? }       focus the matched agent (outline + motion swap)
 *
 *   { type: "panCamera", dx?, dy?, ms? }             pan the stage camera by (dx, dy) over `ms`
 *   { type: "setMotion", target, motion: string }   immediately swap the matched agent's motion
 *                                                    role (e.g. 'dizzy', 'wave'). Persists until a
 *                                                    later setMotion or focus call replaces it.
 *   { type: "showCard" } / { type: "hideCard" }      let the ShelterCharacterCard render during the
 *                                                    run (default suppressed)
 *   { type: "pulseCardTab", tab?: string }           draw attention to a card tab with a pulse +
 *                                                    glow CSS class. Pass null to clear.
 *   { type: "pulseRoom", room?: roomId }             pulse a room on the stage in bright yellow
 *                                                    (used during assignment-mode to point at the
 *                                                    target room). Pass null to clear.
 *   { type: "startAssignmentMode", target }          engage room-picker for the matched agent so
 *                                                    the player can tap a work room directly
 *   { type: "awaitAssignmentMode" }                  block until the player engages assignment mode
 *                                                    (e.g. by tapping the Assignment tab)
 *   { type: "awaitAssignment", target, roomId? }     block until the matched agent's manual
 *                                                    assignment matches `roomId` (any room if
 *                                                    omitted). Player-driven progression.
 *   { type: "awaitCollect" }                         block until the player taps a ready room and
 *                                                    collects the payout (detected via cash delta).
 *   { type: "showCarousel", source?: "starter" }    slide in the agent-card carousel sourced from
 *                                                    starter-tagged characters; remains visible
 *                                                    until `hideCarousel` or step end
 *   { type: "hideCarousel" }                         slide the carousel back out
 *   { type: "exitFocus" }                            release any current camera/character focus
 *   { type: "playStep", id: string }                 chain into another step from scripts.json
 *                                                    (runs its actions inline within this run, so
 *                                                    the cancel-token still works)
 *
 * Deprecated action aliases kept for one release: walkCharacterRole,
 * walkInHired, focusCharacterRole, focusHired — each warns once and
 * routes to its target-shaped equivalent.
 *
 * The runtime is decoupled from any specific view — the caller passes
 * a context with `resolveCharacter(role)`, `walk(pubkey, ...)`,
 * `walkIn(pubkey, ...)`, and `focus(pubkey, ...)` so the same runtime
 * can drive Shelter today and any future scene.
 *
 * Tap delivery: external code (the tap-hint button) calls `tap()` to
 * resolve any in-flight `awaitForTap()`. If no tap is pending, it's a
 * no-op so accidental taps don't queue.
 */

const subscribers = new Set()

let state = {
  active: false,            // runtime is currently driving a step
  stepId: null,
  actionIndex: 0,
  overlayAlpha: 0,          // [0..1] — black-screen scrim
  hudHidden: false,
  dialog: null,             // { speakerRole, speakerName, speakerAvatarUrl, text } | null
  awaitingTap: false,       // tap-to-advance hint visible
  carousel: null,            // { source } | null — agent-card carousel overlay
  hiredPubkey: null,         // set when the player taps Hire on a carousel card
  cardVisible: false,        // suppress / unsuppress ShelterCharacterCard during a run
  pulseTab: null,            // 'profile' | 'schedule' | 'assignment' | null — tab id to highlight
  pulseRoom: null,           // roomId | null — room to bright-yellow pulse on the stage
  pulseGameTab: null,        // 'stage' | 'build' | 'agents' | null — bottom-nav tab to highlight
  pulseBuildCard: null,      // roomTypeId | null — card to highlight in the build carousel
}

let cancelToken = 0
let resolveTap = null

function emit() {
  for (const fn of subscribers) {
    try { fn(state) } catch (err) { console.warn('[tutorial]', err) }
  }
}

function set(patch) {
  state = { ...state, ...patch }
  emit()
}

export function getState() { return state }

export function subscribe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** Records which carousel card the player Hire'd. The runtime later
 *  reads this when actions resolve `target: "hired"` so the chosen recruit
 *  walks in. Cleared on reset / step end. */
export function setHired(pubkey) {
  console.log('[tutorial-walkin] setHired', pubkey)
  set({ hiredPubkey: pubkey || null })
}

export function tap() {
  if (resolveTap) {
    const r = resolveTap
    resolveTap = null
    set({ awaitingTap: false })
    r()
  }
}

export function reset() {
  cancelToken++              // invalidate any in-flight play loop
  if (resolveTap) { resolveTap(); resolveTap = null }
  set({
    active: false, stepId: null, actionIndex: 0,
    overlayAlpha: 0, hudHidden: false,
    dialog: null, awaitingTap: false, carousel: null,
    hiredPubkey: null, cardVisible: false, pulseTab: null, pulseRoom: null,
    pulseGameTab: null, pulseBuildCard: null,
  })
  // Stage-side override cleanup is handled by the caller's ctx when
  // it re-plays via play(); here we just snap state back so the panel
  // re-renders without stale dialog / carousel.
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function awaitForTap() {
  return new Promise((r) => { resolveTap = r })
}

async function tweenOverlay(toAlpha, ms, isCancelled) {
  const fromAlpha = state.overlayAlpha
  const startedAt = performance.now()
  const dur = Math.max(1, ms)
  while (true) {
    if (isCancelled()) return
    const t = Math.min(1, (performance.now() - startedAt) / dur)
    set({ overlayAlpha: fromAlpha + (toAlpha - fromAlpha) * t })
    if (t >= 1) return
    await new Promise((r) => requestAnimationFrame(r))
  }
}

/**
 * Resolve an actor-targeting selector to a pubkey string.
 *
 * Accepted shapes:
 *   "hired"            — the most-recently-Hired carousel agent (state.hiredPubkey)
 *   { hired: true }    — same as above
 *   { pubkey: "abc…" } — explicit pubkey
 *   { role: "..." }    — role lookup via ctx.resolveCharacter
 *
 * Returns null when the selector can't resolve. Callers fall back to
 * an `await sleep(ms)` so a missing target stalls gracefully instead
 * of deadlocking the run.
 */
/**
 * Substitute `{hiredName}` (and future `{...}` placeholders) in a
 * dialog text string. Looks up the recruit's display name via
 * ctx.resolveCharacter; resolves to '' if no recruit is set, so a
 * stray placeholder degrades to "blank space" rather than the literal
 * brace text.
 */
function applyTemplate(text, ctx) {
  if (!text || typeof text !== 'string') return text
  const hiredName = state.hiredPubkey && ctx?.resolveCharacter
    ? (ctx.resolveCharacter({ pubkey: state.hiredPubkey })?.name ?? '')
    : ''
  return text.replace(/\{hiredName\}/g, hiredName)
}

function resolveTarget(target, ctx) {
  if (target == null) return null
  if (target === 'hired' || target?.hired) return state.hiredPubkey ?? null
  if (typeof target === 'string') return null
  if (target.pubkey) return String(target.pubkey)
  if (target.role && ctx?.resolveCharacter) {
    const c = ctx.resolveCharacter({ role: target.role })
    return c?.pubkey ?? null
  }
  return null
}

async function runAction(action, ctx, isCancelled) {
  switch (action.type) {
    case 'hideHud':
      set({ hudHidden: true })
      return
    case 'showHud':
      set({ hudHidden: false })
      return
    case 'setOverlay':
      set({ overlayAlpha: Number(action.alpha ?? 0) })
      return
    case 'fadeOverlay':
      await tweenOverlay(Number(action.to ?? 0), Number(action.ms ?? 600), isCancelled)
      return
    case 'delay':
      await sleep(Number(action.ms ?? 0))
      return
    case 'dialog': {
      // Resolve speaker via the target shape (`speaker: "hired" | { role } |
      // { pubkey }`) when present; fall back to the legacy `speakerRole`
      // shorthand. Either way ctx.resolveCharacter looks up the actual
      // name + avatar for the dialog box.
      let speaker = null
      if (action.speaker !== undefined) {
        const pubkey = resolveTarget(action.speaker, ctx)
        if (pubkey && ctx.resolveCharacter) {
          speaker = ctx.resolveCharacter({ pubkey })
        }
      }
      if (!speaker && action.speakerRole && ctx.resolveCharacter) {
        speaker = ctx.resolveCharacter({ role: action.speakerRole })
      }
      set({
        dialog: {
          speakerRole: action.speakerRole ?? null,
          speakerName: speaker?.name ?? action.speakerRole ?? '',
          speakerAvatarUrl: speaker?.avatarUrl ?? null,
          text: applyTemplate(action.text ?? '', ctx),
        },
      })
      if (action.tapToAdvance) {
        set({ awaitingTap: true })
        await awaitForTap()
        // Tap dismisses the dialog. The view keeps it mounted briefly
        // with a fading class so the disappearance is animated.
        set({ awaitingTap: false, dialog: null })
      }
      return
    }
    case 'parallel': {
      const list = Array.isArray(action.actions) ? action.actions : []
      await Promise.all(list.map((a) => runAction(a, ctx, isCancelled)))
      return
    }
    case 'walkAgent': {
      const pubkey = resolveTarget(action.target, ctx)
      if (pubkey && ctx.walk) {
        await ctx.walk(pubkey, action.dx ?? 0, action.dy ?? 0, action.ms ?? 1500)
      } else {
        if (!pubkey) console.warn('[tutorial] walkAgent: target did not resolve', action.target)
        await sleep(action.ms ?? 1500)
      }
      return
    }
    case 'panCamera': {
      if (ctx.panCamera) {
        await ctx.panCamera(action.dx ?? 0, action.dy ?? 0, action.ms ?? 1500)
      } else {
        await sleep(action.ms ?? 1500)
      }
      return
    }
    case 'cameraTo': {
      if (ctx.cameraTo) await ctx.cameraTo(action.state ?? 'room', action.ms ?? 1500)
      else await sleep(action.ms ?? 1500)
      return
    }
    case 'walkInAgent': {
      const pubkey = resolveTarget(action.target, ctx)
      if (pubkey && ctx.walkIn) {
        await ctx.walkIn(pubkey, action.fromOffsetX ?? 1.5, action.dx ?? -1.5, action.ms ?? 2500)
      } else {
        if (!pubkey) console.warn('[tutorial] walkInAgent: target did not resolve', action.target)
        await sleep(action.ms ?? 1500)
      }
      return
    }
    case 'focusAgent': {
      const pubkey = resolveTarget(action.target, ctx)
      if (pubkey && ctx.focus) {
        const focusOpts = {
          outline: action.outline !== false,
          motionRole: action.motion === undefined ? 'wave' : action.motion,
          closeup: !!action.closeup,
        }
        try { await ctx.focus(pubkey, focusOpts) } catch {}
      } else if (!pubkey) {
        console.warn('[tutorial] focusAgent: target did not resolve', action.target)
      }
      // Camera tween + role swap settle. Default 1500ms matches
      // FOCUS_TWEEN_MS in ShelterStage3D.
      await sleep(Number(action.ms ?? 1500))
      return
    }
    case 'setMotion': {
      const pubkey = resolveTarget(action.target, ctx)
      if (pubkey && ctx.setMotion) {
        await ctx.setMotion(pubkey, action.motion ?? null)
      } else if (!pubkey) {
        console.warn('[tutorial] setMotion: target did not resolve', action.target)
      }
      return
    }
    case 'showCard': {
      set({ cardVisible: true })
      return
    }
    case 'hideCard': {
      set({ cardVisible: false })
      return
    }
    case 'pulseCardTab': {
      set({ pulseTab: action.tab ?? null })
      return
    }
    case 'pulseRoom': {
      set({ pulseRoom: action.room ?? null })
      return
    }
    case 'pulseGameTab': {
      set({ pulseGameTab: action.tab ?? null })
      return
    }
    case 'pulseBuildCard': {
      // Card id matches a room-type id (e.g. 'break-room'). The
      // build carousel subscribes to tutorial state and applies an
      // is-pulsing class to the matching card.
      set({ pulseBuildCard: action.roomType ?? null })
      return
    }
    case 'awaitBuildMode': {
      // Block until shelterBuildMode flips active (player tapped
      // the Build tab).
      if (!ctx.isBuildModeActive) {
        await sleep(action.ms ?? 500)
        return
      }
      await new Promise((resolve) => {
        const check = () => {
          if (isCancelled()) { resolve(); return }
          if (ctx.isBuildModeActive()) { resolve(); return }
          setTimeout(check, 200)
        }
        check()
      })
      return
    }
    case 'awaitBuildSelection': {
      // Block until the player taps a card in the build carousel.
      // If `roomType` is provided, only that specific selection
      // resolves; otherwise any selection unblocks.
      const wantedType = action.roomType ?? null
      if (!ctx.getBuildSelection) {
        await sleep(action.ms ?? 500)
        return
      }
      await new Promise((resolve) => {
        const check = () => {
          if (isCancelled()) { resolve(); return }
          const sel = ctx.getBuildSelection()
          if (wantedType ? sel === wantedType : !!sel) { resolve(); return }
          setTimeout(check, 200)
        }
        check()
      })
      return
    }
    case 'awaitBuilt': {
      // Block until a built room of `roomType` (or any built room if
      // omitted) appears in the store. The param is `roomType`, NOT
      // `type` — a JSON action object can only have one `type` key,
      // and that's already the action discriminator.
      const wantedType = action.roomType ?? null
      if (!ctx.hasBuiltRoom) {
        await sleep(action.ms ?? 500)
        return
      }
      await new Promise((resolve) => {
        const check = () => {
          if (isCancelled()) { resolve(); return }
          if (ctx.hasBuiltRoom(wantedType)) { resolve(); return }
          setTimeout(check, 200)
        }
        check()
      })
      return
    }
    case 'startAssignmentMode': {
      // Pre-arm the room picker so the player can tap a glowing
      // work room directly — they don't need to first open the
      // Assignment tab on the card.
      const pubkey = resolveTarget(action.target ?? 'hired', ctx)
      if (pubkey && ctx.startAssignmentMode) ctx.startAssignmentMode(pubkey)
      return
    }
    case 'awaitAssignmentMode': {
      // Block until shelterAssignmentMode flips active. Used in step
      // 3 — we want the dialog to wait specifically for the player
      // to tap the Assignment tab (which auto-engages mode), not for
      // any tap-anywhere advance. Otherwise the layer-tap eats the
      // first tab click and advances the dialog instead.
      if (!ctx.isAssignmentModeActive) {
        await sleep(action.ms ?? 500)
        return
      }
      await new Promise((resolve) => {
        const check = () => {
          if (isCancelled()) { resolve(); return }
          if (ctx.isAssignmentModeActive()) { resolve(); return }
          setTimeout(check, 200)
        }
        check()
      })
      return
    }
    case 'awaitCollect': {
      // Block until the player taps a ready room and collects its
      // production. Detected via cash increasing from a baseline
      // captured at action start. The room id is arbitrary — any
      // collection unblocks; we don't care which room, only that
      // some payout landed in the wallet.
      const startCash = ctx.getCash?.() ?? 0
      await new Promise((resolve) => {
        const check = () => {
          if (isCancelled()) { resolve(); return }
          const now = ctx.getCash?.() ?? 0
          if (now > startCash) { resolve(); return }
          setTimeout(check, 200)
        }
        check()
      })
      return
    }
    case 'awaitAssignment': {
      // Block until the matched agent's manualAssignment.roomId
      // equals action.roomId. Polls the host's getAssignment() at a
      // gentle cadence — the player's expected to do something soon
      // so we don't need a per-frame check.
      const targetPubkey = resolveTarget(action.target ?? 'hired', ctx)
      const wantedRoom = action.roomId ?? null
      if (!targetPubkey || !ctx.getAssignment) {
        await sleep(500)
        return
      }
      await new Promise((resolve) => {
        const check = () => {
          if (isCancelled()) { resolve(); return }
          const current = ctx.getAssignment(targetPubkey)
          if (wantedRoom ? current === wantedRoom : !!current) {
            resolve()
            return
          }
          setTimeout(check, 200)
        }
        check()
      })
      return
    }
    case 'showCarousel': {
      set({ carousel: { source: action.source ?? 'starter' } })
      return
    }
    case 'hideCarousel': {
      set({ carousel: null })
      return
    }
    case 'exitFocus': {
      if (ctx.exitFocus) {
        try { await ctx.exitFocus() } catch {}
      }
      return
    }
    case 'playStep': {
      const next = action.id && ctx.findStep ? ctx.findStep(action.id) : null
      if (!next) {
        console.warn('[tutorial] playStep: unknown id', action.id)
        return
      }
      // Run the chained step's actions inline using the same cancel
      // token so reset() still aborts the whole chain.
      for (let j = 0; j < next.actions.length; j++) {
        if (isCancelled()) return
        set({ stepId: next.id, actionIndex: j })
        await runAction(next.actions[j], ctx, isCancelled)
      }
      return
    }
    // ── Deprecated action names — aliases that translate to the new
    // target-shaped actions. Will be removed once we're confident no
    // scripts depend on them; for now they warn and pass through.
    case 'walkCharacterRole':
      deprecate('walkCharacterRole', 'walkAgent')
      return runAction({ ...action, type: 'walkAgent', target: { role: action.role } }, ctx, isCancelled)
    case 'walkInHired':
      deprecate('walkInHired', 'walkInAgent')
      return runAction({ ...action, type: 'walkInAgent', target: 'hired' }, ctx, isCancelled)
    case 'focusCharacterRole':
      deprecate('focusCharacterRole', 'focusAgent')
      return runAction({ ...action, type: 'focusAgent', target: { role: action.role } }, ctx, isCancelled)
    case 'focusHired':
      deprecate('focusHired', 'focusAgent')
      return runAction({ ...action, type: 'focusAgent', target: 'hired' }, ctx, isCancelled)
    default:
      console.warn('[tutorial] unknown action', action)
  }
}

// One warn per deprecated action name per page load — without this a
// long script that uses an old name a dozen times floods the console.
const _deprecatedSeen = new Set()
function deprecate(oldName, newName) {
  if (_deprecatedSeen.has(oldName)) return
  _deprecatedSeen.add(oldName)
  console.warn(`[tutorial] action "${oldName}" is deprecated; use "${newName}" with target: { … } instead`)
}

/**
 * Run a step end-to-end.
 *
 * @param {object} step  parsed step from scripts.json
 * @param {object} ctx
 * @param {(query:{role?:string,pubkey?:string})=>{name,pubkey,avatarUrl}|null} ctx.resolveCharacter
 * @param {(pubkey:string)=>Promise<void>}                                       ctx.focusCharacter
 */
export async function play(step, ctx) {
  cancelToken++
  const myToken = cancelToken
  const isCancelled = () => myToken !== cancelToken
  // Reset any leftover cinematic overrides from a previous run so
  // (e.g.) Edi snaps back to the middle of the room before the new
  // run begins, instead of starting wherever the last walk left him.
  if (ctx?.clearTutorialOverrides) {
    try { await ctx.clearTutorialOverrides() } catch {}
  }
  set({
    active: true,
    stepId: step.id,
    actionIndex: 0,
    overlayAlpha: 0,
    hudHidden: false,
    dialog: null,
    awaitingTap: false,
    hiredPubkey: null,
    cardVisible: false,
    pulseTab: null,
    pulseRoom: null,
    pulseGameTab: null,
    pulseBuildCard: null,
  })
  try {
    for (let i = 0; i < step.actions.length; i++) {
      if (isCancelled()) return
      set({ actionIndex: i })
      await runAction(step.actions[i], ctx, isCancelled)
    }
  } finally {
    if (!isCancelled()) {
      // active flips off so the dev panel's "running" indicator
      // clears, and the dialog/carousel/await-tap UI tears down. We
      // intentionally LEAVE cardVisible + pulseTab set — the final
      // step in a run often points the player at a UI element they
      // need to interact with, and we want that highlight to persist
      // until reset() or another step explicitly clears it.
      set({ active: false, dialog: null, awaitingTap: false, carousel: null })
    }
  }
}

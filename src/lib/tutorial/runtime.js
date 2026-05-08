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
 *   { type: "walkCharacterRole",
 *           role: string, dx?: number,
 *           dy?: number, ms?: number }              animate the agent (matched by role) along (dx,dy)
 *                                                    over `ms` while playing the walk motion
 *   { type: "panCamera", dx?, dy?, ms? }             pan the stage camera by (dx, dy) over `ms`
 *   { type: "walkInHired", fromOffsetX?, dx?, ms? } park the most-recently-Hired carousel agent at
 *                                                    fromOffsetX off-camera, then walk dx units in
 *   { type: "focusHired", outline?, motion?,
 *                          closeup?, ms? }            focus the most-recently-Hired agent (outline +
 *                                                    motion swap), like focusCharacterRole but for
 *                                                    a pubkey instead of a role tag
 *   { type: "showCarousel", source?: "starter" }    slide in the agent-card carousel sourced from
 *                                                    starter-tagged characters; remains visible
 *                                                    until `hideCarousel` or step end
 *   { type: "hideCarousel" }                         slide the carousel back out
 *   { type: "exitFocus" }                            release any current camera/character focus
 *   { type: "playStep", id: string }                 chain into another step from scripts.json
 *                                                    (runs its actions inline within this run, so
 *                                                    the cancel-token still works)
 *   { type: "focusCharacterRole", role: string,
 *                                 ms?: number,
 *                                 outline?: bool,
 *                                 motion?: string|null,
 *                                 closeup?: bool }   camera focus on the NPC with that role;
 *                                                    waits `ms` for the tween to settle.
 *                                                    `closeup:true` gives a tight full-body
 *                                                    framing, `outline:false` skips the red
 *                                                    selection outline, `motion` overrides the
 *                                                    role tag played on focus (default 'wave')
 *
 * The runtime is decoupled from any specific view — the caller passes
 * a context with `resolveCharacter(role)` and `focusCharacter(pubkey)`
 * so the same runtime can drive Shelter today and any future scene.
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
 *  reads this in actions like `walkInHired` so the chosen recruit
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
    hiredPubkey: null,
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
      const speaker = ctx.resolveCharacter
        ? ctx.resolveCharacter({ role: action.speakerRole })
        : null
      set({
        dialog: {
          speakerRole: action.speakerRole ?? null,
          speakerName: speaker?.name ?? action.speakerRole ?? '',
          speakerAvatarUrl: speaker?.avatarUrl ?? null,
          text: action.text ?? '',
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
    case 'walkCharacterRole': {
      const speaker = ctx.resolveCharacter
        ? ctx.resolveCharacter({ role: action.role })
        : null
      if (speaker?.pubkey && ctx.walkAgent) {
        await ctx.walkAgent(speaker.pubkey, action.dx ?? 0, action.dy ?? 0, action.ms ?? 1500)
      } else {
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
    case 'walkInHired': {
      console.log('[tutorial-walkin] action fired', {
        hiredPubkey: state.hiredPubkey,
        hasCtxWalkIn: !!ctx.walkInHired,
        fromOffsetX: action.fromOffsetX, dx: action.dx, ms: action.ms,
      })
      if (!state.hiredPubkey) {
        console.warn('[tutorial-walkin] no hiredPubkey set — did the carousel onHire fire?')
      }
      if (state.hiredPubkey && ctx.walkInHired) {
        await ctx.walkInHired(state.hiredPubkey, action.fromOffsetX ?? 1.5, action.dx ?? -1.5, action.ms ?? 2500)
      } else {
        await sleep(action.ms ?? 1500)
      }
      return
    }
    case 'focusHired': {
      // Once the new recruit has walked into frame, focus them so
      // they pick up the red selection outline + the requested motion
      // (default 'wave' for that "say hi" beat). Reuses the same
      // ctx.focusCharacter path the focusCharacterRole action uses,
      // pointed at the carousel-Hire'd pubkey instead of a role.
      if (state.hiredPubkey && ctx.focusCharacter) {
        const focusOpts = {
          outline: action.outline !== false,
          motionRole: action.motion === undefined ? 'wave' : action.motion,
          closeup: !!action.closeup,
        }
        try { await ctx.focusCharacter(state.hiredPubkey, focusOpts) } catch {}
      }
      await sleep(Number(action.ms ?? 1200))
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
    case 'focusCharacterRole': {
      const speaker = ctx.resolveCharacter
        ? ctx.resolveCharacter({ role: action.role })
        : null
      if (speaker?.pubkey && ctx.focusCharacter) {
        const focusOpts = {
          outline: action.outline !== false,
          motionRole: action.motion === undefined ? 'wave' : action.motion,
          closeup: !!action.closeup,
        }
        try { await ctx.focusCharacter(speaker.pubkey, focusOpts) } catch {}
      }
      // Let the camera tween + role swap settle. Default 1500ms matches
      // the existing FOCUS_TWEEN_MS in ShelterStage3D.
      await sleep(Number(action.ms ?? 1500))
      return
    }
    default:
      console.warn('[tutorial] unknown action', action)
  }
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
  })
  try {
    for (let i = 0; i < step.actions.length; i++) {
      if (isCancelled()) return
      set({ actionIndex: i })
      await runAction(step.actions[i], ctx, isCancelled)
    }
  } finally {
    if (!isCancelled()) {
      set({ active: false, dialog: null, awaitingTap: false, carousel: null })
    }
  }
}

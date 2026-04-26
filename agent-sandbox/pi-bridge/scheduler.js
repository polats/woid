/**
 * Tick scheduler — heartbeat-driven turn pacing with scene-aware
 * cadence.
 *
 * Today's bridge fires turns reactively: a room message or a movement
 * event sets `rec.pendingTrigger` and a debounce window flushes it
 * through `runPiTurn`. That works once a conversation is going, but
 * when a character is alone with nothing incoming, they sit silent
 * forever. This scheduler adds a per-character tick that fires a
 * `heartbeat` trigger so the LLM is asked "what would you do right
 * now?" at a sane cadence.
 *
 * Cadence depends on whether the character has any scene-mates within
 * SCENE_RADIUS:
 *
 *   alone    →  ALONE_MIN..ALONE_MAX ms  (~30–60s)
 *   in-scene →  SCENE_MIN..SCENE_MAX ms  (~5–10s)
 *
 * Both ranges are uniform-random per tick so two characters in the
 * same scene don't lockstep into chorus replies. Reactive triggers
 * (message_received, arrival) still fire through the existing
 * `tryListenTurn` path and are unaffected — they just happen sooner
 * than a heartbeat would.
 *
 * This is the minimum scheduler needed to exercise scenes / perception
 * end-to-end. The full vision in #140 (urgency tiers, global
 * dampener, addressed-vs-ambient classification) and slice 5 of #225
 * (conversation gate, hard cap, cooldown) build on top.
 */

import { sceneMatesOf } from "./scenes.js";

export const DEFAULTS = {
  aloneMinMs: 30_000,
  aloneMaxMs: 60_000,
  sceneMinMs: 5_000,
  sceneMaxMs: 10_000,
};

/**
 * Create a scheduler bound to the bridge's snapshot + turn fn.
 *
 * @param {{
 *   getSnapshot: (agentId: string) => any,
 *   runTurn: (rec: any, opts: { trigger: string, triggerContext: object }) => Promise<any>,
 *   now?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   random?: () => number,
 * }} deps
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
export function createScheduler(deps, opts = {}) {
  if (typeof deps?.getSnapshot !== "function") throw new Error("createScheduler: getSnapshot required");
  if (typeof deps?.runTurn !== "function") throw new Error("createScheduler: runTurn required");
  const { aloneMinMs, aloneMaxMs, sceneMinMs, sceneMaxMs } = { ...DEFAULTS, ...opts };
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const random = deps.random ?? Math.random;

  /** @type {Map<string, any>} agentId → active timer handle */
  const timers = new Map();

  function nextCadenceMs(rec) {
    const snap = deps.getSnapshot(rec.agentId);
    const inScene = sceneMatesOf(snap, rec.pubkey).length > 0;
    const [lo, hi] = inScene ? [sceneMinMs, sceneMaxMs] : [aloneMinMs, aloneMaxMs];
    return Math.round(lo + random() * (hi - lo));
  }

  function scheduleNext(rec) {
    cancel(rec.agentId);
    if (!rec.listening) return;
    const ms = nextCadenceMs(rec);
    const t = setTimeoutFn(() => onTick(rec), ms);
    if (typeof t?.unref === "function") t.unref();
    timers.set(rec.agentId, t);
  }

  async function onTick(rec) {
    timers.delete(rec.agentId);
    if (!rec.listening) return;
    if (rec.thinking) {
      // Don't double-trigger; reschedule and try again.
      scheduleNext(rec);
      return;
    }
    try {
      await deps.runTurn(rec, { trigger: "heartbeat", triggerContext: {} });
    } catch (err) {
      console.error(`[scheduler:${rec.agentId}] heartbeat threw:`, err?.message || err);
    }
    if (rec.listening) scheduleNext(rec);
  }

  function attach(rec) {
    scheduleNext(rec);
  }

  function detach(rec) {
    cancel(rec?.agentId);
  }

  function cancel(agentId) {
    if (!agentId) return;
    const t = timers.get(agentId);
    if (t) clearTimeoutFn(t);
    timers.delete(agentId);
  }

  return {
    attach,
    detach,
    /** For tests / `/health` introspection. */
    activeAgentIds: () => [...timers.keys()],
    /** Compute the next cadence ms without scheduling — useful for tests. */
    _nextCadenceMs: nextCadenceMs,
  };
}

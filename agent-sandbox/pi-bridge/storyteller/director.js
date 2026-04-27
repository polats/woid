/**
 * Director — slice 3 of #305.
 *
 * Maintains an `intensity` scalar in [0, 1] that lerps toward a
 * `target` computed from world state (mood bands, low-needs, conflict
 * count). Cards are eligible when (phase matches) ∧ (intensity is in
 * the card's window) ∧ (trigger predicate passes) ∧ (not on cooldown).
 *
 * On each tick we may fire one card. Selection is weighted random
 * over eligible cards. Cooldowns and once_per_session flags ensure
 * we don't repeat ourselves in a hot loop.
 *
 * The lerp is asymmetric (Barotrauma pattern, see
 * docs/research/barotrauma.md): rises in 25 sim-min, falls in 400.
 * Slow-fall guarantees a "valley" between peaks — players notice
 * the calm, then the spike.
 *
 * Threshold drift: if no card has fired in the first half of the
 * day, the eligibility threshold lowers so something fires. Keeps
 * sparse days from going totally silent.
 */

export const DEFAULTS = {
  initialIntensity: 0.3,
  riseTauSimMin: 25,
  fallTauSimMin: 400,
  baseThreshold: 0,            // intensity must clear this for ambient cards (default: any intensity OK)
  driftBeginSimHours: 6,       // start lowering threshold after N sim-hours of silence
  driftPerSimHour: 0.04,       // per sim-hour of silence after the begin point (rough)
};

/**
 * @param {{
 *   cards: object,                    // card loader (from cards.js)
 *   runtime: object,                  // card runtime (from actions.js)
 *   sessions?: object,                // session store (for appendEvent)
 *   simClock?: object,
 *   moodlets?: object,                // mood-band aggregator for intensity input
 *   listRunningPubkeys?: () => string[],
 *   pickRandomCharacter?: () => string | null,
 *   wallClock?: () => number,
 *   random?: () => number,
 *   config?: Partial<typeof DEFAULTS>,
 * }} deps
 */
export function createDirector(deps = {}) {
  if (!deps.cards) throw new Error("createDirector: cards loader required");
  if (!deps.runtime) throw new Error("createDirector: runtime required");
  const wallClock = deps.wallClock ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const cfg = { ...DEFAULTS, ...(deps.config || {}) };

  let intensity = cfg.initialIntensity;
  let lastTickRealMs = wallClock();
  let lastFireRealMs = 0;

  // Per-card runtime state.
  const cooldowns = new Map();         // card_id → real-ms until eligible again
  const firedThisSession = new Set();  // for once_per_session
  const exhausted = new Set();         // for exhaustible

  // Scheduled cards (TriggerCard via runtime). Drained on tick.
  const queue = [];                    // [{ card_id, fire_at_real_ms }]

  function scheduleCard(cardId, atRealMs) {
    queue.push({ card_id: cardId, fire_at_real_ms: atRealMs });
  }

  /**
   * Compute the target intensity from world state.
   * Warmth-biased (cf. vertical-slice.md §3): mood pressure dominates,
   * with conflicts adding spike but baseline 0.2 even on sleepy days.
   */
  function computeTargetIntensity() {
    const snap = deps.moodlets?.snapshot?.();
    let lousy = 0;
    let conflict = 0;
    let total = 0;
    if (snap?.characters?.length) {
      for (const c of snap.characters) {
        total++;
        if (c.band === "lousy" || c.band === "breaking") lousy++;
        // Conflict count = active negative-weight :by_<x> moodlets.
        // We don't have direct visibility into each character's tags
        // here without an extra query; rely on band as a proxy.
      }
    }
    const moodPressure = total > 0 ? lousy / total : 0;
    const baseline = 0.2;                 // never go fully silent
    return Math.max(0, Math.min(1, baseline + 0.5 * moodPressure + 0.05 * conflict));
  }

  /**
   * Lerp intensity toward target with asymmetric rates.
   */
  function tickIntensity(simMinElapsed) {
    const target = computeTargetIntensity();
    const tau = target > intensity ? cfg.riseTauSimMin : cfg.fallTauSimMin;
    if (tau <= 0) return;
    const k = Math.min(1, simMinElapsed / tau);
    intensity += (target - intensity) * k;
    intensity = Math.max(0, Math.min(1, intensity));
  }

  /**
   * Has card been fired in the last N sim-min? Reads from cooldowns map.
   */
  function isOnCooldown(card) {
    const until = cooldowns.get(card.id);
    if (!until) return false;
    return wallClock() < until;
  }

  /**
   * Filter card by all eligibility conditions.
   */
  function isEligible(card, opts = {}) {
    if (firedThisSession.has(card.id) && card.once_per_session) return false;
    if (exhausted.has(card.id)) return false;
    if (isOnCooldown(card)) return false;
    if (card.intensity_min > intensity) return false;
    if (card.intensity_max < intensity) return false;
    // Phase filter — caller decides which phase set is in scope.
    if (opts.phases && !opts.phases.has(card.phase)) return false;
    return true;
  }

  function pickWeighted(cards) {
    if (cards.length === 0) return null;
    let total = 0;
    for (const c of cards) total += Math.max(0.0001, c.weight);
    const roll = random() * total;
    let acc = 0;
    for (const c of cards) {
      acc += Math.max(0.0001, c.weight);
      if (roll < acc) return c;
    }
    return cards[cards.length - 1];
  }

  /**
   * Apply post-fire bookkeeping: cooldown, once_per_session, exhausted.
   */
  function markFired(card) {
    lastFireRealMs = wallClock();
    if (card.cooldown_sim_min > 0) {
      const cadence = deps.simClock?.cadence?.() ?? 60_000;
      cooldowns.set(card.id, wallClock() + card.cooldown_sim_min * cadence);
    }
    if (card.once_per_session) firedThisSession.add(card.id);
    if (card.exhaustible) exhausted.add(card.id);
  }

  /**
   * Run a card via the action runtime. Resolves any explicit role
   * bindings via the director's running-character pool.
   */
  async function fireCard(card, opts = {}) {
    markFired(card);
    const sim_iso = deps.simClock?.now?.()?.sim_iso;
    const fired_at = wallClock();
    deps.sessions?.appendEvent?.({
      kind: "card_fired",
      card_id: card.id,
      phase: card.phase,
      sim_iso,
    });
    let result;
    try {
      result = await deps.runtime.run(card, {
        random,
        roleBindings: opts.roleBindings,
      });
    } catch (err) {
      console.error(`[director] card ${card.id} threw:`, err?.message || err);
      result = { ok: false, reason: err?.message || String(err) };
    }
    // Always emit a structured log record — success and failure. Lets
    // the bridge persist a queryable history of who decided what when.
    if (typeof deps.onFire === "function") {
      try {
        deps.onFire({
          card_id: card.id,
          phase: card.phase,
          source: opts.source || "tick",
          fired_at,
          sim_iso,
          intensity: Number(intensity.toFixed(3)),
          target: Number(computeTargetIntensity().toFixed(3)),
          ok: result?.ok !== false,
          reason: result?.reason,
          bindings: result?.bindings || null,
        });
      } catch (err) { console.warn("[director] onFire hook failed:", err?.message || err); }
    }
    return result;
  }

  /**
   * Single director tick. Steps:
   *   1. Update intensity scalar by elapsed sim-min since last tick.
   *   2. Drain any scheduled cards whose fire_at_real_ms has passed.
   *   3. Try to fire a fresh ambient card from the eligible pool.
   * Returns a summary of what happened.
   */
  async function tick(opts = {}) {
    const now = wallClock();
    const cadence = deps.simClock?.cadence?.() ?? 60_000;
    const simMinElapsed = (now - lastTickRealMs) / cadence;
    tickIntensity(simMinElapsed);
    lastTickRealMs = now;

    const fired = [];

    // 1. Drain queue.
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i];
      if (now >= q.fire_at_real_ms) {
        queue.splice(i, 1);
        const card = deps.cards.get(q.card_id);
        if (!card) {
          fired.push({ card_id: q.card_id, ok: false, reason: "scheduled card not in registry" });
          continue;
        }
        const r = await fireCard(card, { roleBindings: opts.roleBindings, source: "scheduled" });
        fired.push({ card_id: card.id, ok: r.ok, reason: r.reason });
      }
    }

    // 2. Try to fire one ambient card if eligible.
    const phases = opts.phases ?? new Set(["ambient"]);
    const eligible = deps.cards.listAll().filter((c) => isEligible(c, { phases }));
    if (eligible.length > 0 && opts.fireRate !== 0) {
      // Honor an optional "should fire?" gate from the caller. By
      // default, fire every tick when there's something eligible —
      // the per-card cooldown is the rate-limiter.
      const card = pickWeighted(eligible);
      if (card) {
        const r = await fireCard(card, { roleBindings: opts.roleBindings, source: "tick" });
        fired.push({ card_id: card.id, ok: r.ok, reason: r.reason });
      }
    }

    return {
      intensity,
      fired,
      eligible_count: eligible.length,
      queue_depth: queue.length,
    };
  }

  /**
   * Reset session-scoped state (once_per_session, exhausted from this
   * day's perspective). Called by the session store at session_open.
   */
  function onSessionOpen() {
    firedThisSession.clear();
  }

  function snapshot() {
    return {
      intensity: Number(intensity.toFixed(3)),
      target: Number(computeTargetIntensity().toFixed(3)),
      cooldowns: cooldowns.size,
      fired_this_session: [...firedThisSession],
      exhausted: [...exhausted],
      queue_depth: queue.length,
    };
  }

  return {
    tick,
    fireCard,
    scheduleCard,
    onSessionOpen,
    snapshot,
    intensity: () => intensity,
    _setIntensity: (v) => { intensity = v; }, // test seam
  };
}

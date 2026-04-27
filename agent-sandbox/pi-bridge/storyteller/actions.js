/**
 * Action DSL runtime — slice 2 of #305.
 *
 * Walks a card's `actions[]` array and executes each verb against the
 * bridge's narrative-state surfaces. Verb semantics mirror gm.js's
 * registry pattern: each entry declares `args`, an effect summary,
 * and a handler. Control flow (Label / GoTo / RNG / CheckData) is
 * implemented in the runner, not the verbs themselves.
 *
 * Slice 2 ships the verbs needed to make existing-character cards
 * fire end-to-end:
 *   EmitMoodlet, ClearMoodletByTag — character mood mutations
 *   ConversationAction              — staged say_to-style line
 *                                     (recorded in session/journal,
 *                                     surfaced as perception)
 *   ModifyRel                       — relationship delta
 *   SetData / CheckData             — local kv state for branching
 *   TriggerCard                     — schedule another card via the
 *                                     director (slice 3)
 *   Wait                            — sim-min pause; runtime resolves
 *                                     when sim-time crosses
 *   RNG                             — random branch with label targets
 *   Label / GoTo                    — pure flow control
 *
 * Deferred to slice 5+ (multi-character spawning):
 *   SpawnAction, DespawnTag
 */

const VERBS = {
  EmitMoodlet: {
    args: ["target", "tag", "weight", "reason", "duration_sim_min", "by"],
    handler: (deps, ctx, args) => {
      const pubkey = ctx.resolve(args.target);
      if (!pubkey) return { ok: false, reason: `unbound role "${args.target}"` };
      const cadence = deps.simClock?.cadence?.() ?? 60_000;
      let durationMs;
      if (Number.isFinite(args.duration_sim_min)) durationMs = args.duration_sim_min * cadence;
      else if (Number.isFinite(args.duration_ms)) durationMs = args.duration_ms;
      const m = deps.moodletsTracker.emit(pubkey, {
        tag: String(args.tag || "card"),
        weight: Number(args.weight) || 0,
        reason: String(args.reason || ""),
        source: "card",
        by: args.by ? ctx.resolve(args.by) : undefined,
        duration_ms: durationMs,
      });
      if (!m) return { ok: false, reason: "emit rejected" };
      deps.perception?.appendOne?.(pubkey, {
        kind: "moodlet_added",
        tag: m.tag,
        weight: m.weight,
        reason: m.reason || null,
      });
      return { ok: true, moodlet_id: m.id };
    },
  },

  ClearMoodletByTag: {
    args: ["target", "pattern"],
    handler: (deps, ctx, args) => {
      const pubkey = ctx.resolve(args.target);
      if (!pubkey) return { ok: false, reason: `unbound role "${args.target}"` };
      const removed = deps.moodletsTracker.clearByTag(pubkey, String(args.pattern || ""));
      return { ok: true, removed };
    },
  },

  Notice: {
    args: ["target", "text"],
    handler: (deps, ctx, args) => {
      const pubkey = ctx.resolve(args.target);
      if (!pubkey) return { ok: false, reason: `unbound role "${args.target}"` };
      const text = String(args.text || "").trim();
      if (!text) return { ok: false, reason: "text required" };
      deps.perception?.appendOne?.(pubkey, { kind: "ambient_moment", text });
      return { ok: true };
    },
  },

  Suggest: {
    // Stage an impulse on the *speaker* — they decide whether and what
    // to actually say via their normal `say_to` verb. Cards never
    // fabricate dialog or attribute words to characters who didn't
    // think of them.
    args: ["target", "text"],
    handler: (deps, ctx, args) => {
      const pubkey = ctx.resolve(args.target);
      if (!pubkey) return { ok: false, reason: `unbound role "${args.target}"` };
      const text = String(args.text || "").trim();
      if (!text) return { ok: false, reason: "text required" };
      deps.perception?.appendOne?.(pubkey, { kind: "card_prompt", text });
      return { ok: true };
    },
  },

  ModifyRel: {
    args: ["from", "to", "delta", "reason"],
    handler: (deps, ctx, args) => {
      const from = ctx.resolve(args.from);
      const to = ctx.resolve(args.to);
      if (!from || !to) return { ok: false, reason: "unbound role" };
      // Slice 2 thin wiring: emit two mirror moodlets that the
      // relationships graph can later aggregate via :by_<x> tags.
      // A proper affinity store lands with #295; this keeps signal
      // flowing without that dependency.
      const cadence = deps.simClock?.cadence?.() ?? 60_000;
      const delta = Math.trunc(Number(args.delta) || 0);
      if (delta === 0) return { ok: true, skipped: true };
      const fromName = deps.loadCharacter?.(from)?.name || from.slice(0, 8);
      const toName = deps.loadCharacter?.(to)?.name || to.slice(0, 8);
      deps.moodletsTracker?.emit?.(from, {
        tag: `rel_change:by_${to}`,
        weight: delta,
        reason: String(args.reason || `feeling differently about ${toName}`),
        source: "card",
        by: to,
        duration_ms: 24 * 60 * cadence, // 24 sim-hours
      });
      return { ok: true, delta, from: fromName, to: toName };
    },
  },

  SetData: {
    args: ["key", "value"],
    handler: (_deps, ctx, args) => {
      if (typeof args.key !== "string" || !args.key) return { ok: false, reason: "key required" };
      ctx.data[args.key] = args.value;
      return { ok: true };
    },
  },

  CheckData: {
    args: ["key", "equals", "then", "else"],
    // Returns a special control-flow result so the runner can branch.
    handler: (_deps, ctx, args) => {
      const v = ctx.data[args.key];
      const eq = args.equals;
      const matches = v === eq || (eq === undefined && v !== undefined);
      return { ok: true, control: { jump: matches ? args.then : args.else } };
    },
  },

  TriggerCard: {
    args: ["card_id", "delay_sim_min"],
    handler: (deps, _ctx, args) => {
      const cardId = String(args.card_id || "");
      if (!cardId) return { ok: false, reason: "card_id required" };
      const cadence = deps.simClock?.cadence?.() ?? 60_000;
      const delayMs = Number.isFinite(args.delay_sim_min) ? args.delay_sim_min * cadence : 0;
      deps.scheduleCard?.(cardId, Date.now() + delayMs);
      return { ok: true };
    },
  },

  Wait: {
    args: ["sim_min"],
    // Returned in the result so the runner can pause cooperatively.
    handler: (_deps, _ctx, args) => {
      const min = Number.isFinite(args.sim_min) ? args.sim_min : 1;
      return { ok: true, control: { wait_sim_min: min } };
    },
  },

  RNG: {
    args: ["prob", "then", "else"],
    handler: (_deps, ctx, args) => {
      const p = clamp01(Number.isFinite(args.prob) ? args.prob : 0.5);
      const roll = ctx.random();
      const matches = roll < p;
      return { ok: true, control: { jump: matches ? args.then : args.else }, roll };
    },
  },

  Label: {
    args: ["name"],
    // Pure marker, no effect.
    handler: () => ({ ok: true, skipped: true }),
  },

  GoTo: {
    args: ["target"],
    handler: (_deps, _ctx, args) => ({ ok: true, control: { jump: String(args.target) } }),
  },
};

/**
 * Index Label actions in a card's action list so GoTo/CheckData/RNG
 * branches can resolve label names → action indices in O(1).
 */
function indexLabels(actions) {
  const idx = new Map();
  actions.forEach((a, i) => {
    if (a?.type === "Label" && typeof a.name === "string") idx.set(a.name, i);
  });
  return idx;
}

/**
 * @param {{
 *   moodletsTracker: object,
 *   sessions?: object,
 *   perception?: object,
 *   simClock?: object,
 *   loadCharacter?: (pk: string) => object | null,
 *   pickRandomCharacter?: (opts?: { withSceneMate?: boolean }) => string | null,
 *   pickSceneMate?: (anchorPubkey: string) => string | null,
 *   scheduleCard?: (cardId: string, atRealMs: number) => void,
 *   wallClock?: () => number,
 * }} deps
 */
export function createCardRuntime(deps = {}) {
  if (!deps.moodletsTracker) throw new Error("createCardRuntime: moodletsTracker required");
  const wallClock = deps.wallClock ?? (() => Date.now());

  /**
   * Run a card's action list. Returns a promise that resolves when
   * the card completes (end of list or terminal action).
   *
   * @param {object} card                   — a card record from cards.js
   * @param {{
   *   roleBindings?: Record<string, string>,
   *   random?: () => number,
   *   onAction?: (a, result) => void,        // observer for tests/inspector
   *   waitFn?: (ms: number) => Promise<void>,// test seam for Wait
   * }} [opts]
   */
  async function run(card, opts = {}) {
    const random = opts.random ?? Math.random;
    const waitFn = opts.waitFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const onAction = opts.onAction;

    // Resolve role-name → pubkey at fire time. random_character draws
    // from the bridge's pickRandomCharacter helper; explicit pubkeys
    // pass through; explicit role-overrides come from opts.roleBindings.
    const bound = { ...(opts.roleBindings || {}) };
    function resolveRole(name) {
      if (!name) return null;
      if (bound[name]) return bound[name];
      const spec = card.roles?.[name];
      if (!spec) return /^[0-9a-f]{64}$/i.test(name) ? name : null;
      // Plain random — any in-room character. Used by atmospheric solo
      // cards (morning-kettle, restless) where the bound character is
      // alone with their thoughts.
      if (spec.select === "random_character" && deps.pickRandomCharacter) {
        const pk = deps.pickRandomCharacter();
        if (pk) bound[name] = pk;
        return pk;
      }
      // Random with at least one scene-mate. Used by Suggest cards
      // whose impulse text presumes the bound speaker has someone
      // nearby they could actually talk to.
      if (spec.select === "random_with_scene_mate" && deps.pickRandomCharacter) {
        const pk = deps.pickRandomCharacter({ withSceneMate: true });
        if (pk) bound[name] = pk;
        return pk;
      }
      // A scene-mate of another already-bound role. Used by mutual
      // cards (shared-quiet) so the two roles end up co-located.
      if (spec.select === "scene_mate" && spec.of && deps.pickSceneMate) {
        const anchor = bound[spec.of] || resolveRole(spec.of);
        if (!anchor) return null;
        const pk = deps.pickSceneMate(anchor);
        if (pk) bound[name] = pk;
        return pk;
      }
      if (typeof spec.select === "string" && /^[0-9a-f]{64}$/i.test(spec.select)) {
        bound[name] = spec.select;
        return spec.select;
      }
      return null;
    }

    const ctx = {
      data: {},
      random,
      resolve: resolveRole,
      cardId: card.id,
      bindings: bound,
    };

    const labels = indexLabels(card.actions);
    const trace = [];
    let pc = 0;
    let safety = card.actions.length * 8 + 16;   // hard ceiling on hops
    while (pc < card.actions.length) {
      if (--safety < 0) {
        return { ok: false, reason: "runaway loop", trace, bindings: bound };
      }
      const a = card.actions[pc];
      const verb = VERBS[a.type];
      if (!verb) {
        trace.push({ pc, type: a.type, error: "unknown verb" });
        return { ok: false, reason: `unknown action type "${a.type}"`, trace, bindings: bound };
      }
      let result;
      try {
        result = await verb.handler(deps, ctx, a);
      } catch (err) {
        trace.push({ pc, type: a.type, error: err?.message || String(err) });
        return { ok: false, reason: err?.message || String(err), trace, bindings: bound };
      }
      trace.push({ pc, type: a.type, result });
      if (typeof onAction === "function") onAction(a, result);
      // Abort the card on action failure unless the action explicitly
      // marks itself non-fatal. Skip for control-flow actions (Label,
      // GoTo) which always succeed and never set ok=false.
      if (result && result.ok === false && a.fatal !== false) {
        return { ok: false, reason: result.reason || "action rejected", trace, bindings: bound };
      }
      const ctrl = result?.control;
      if (ctrl?.jump) {
        const target = labels.get(ctrl.jump);
        if (target == null) {
          return { ok: false, reason: `jump target "${ctrl.jump}" not found`, trace, bindings: bound };
        }
        pc = target + 1; // skip past the Label itself
        continue;
      }
      if (Number.isFinite(ctrl?.wait_sim_min)) {
        const cadence = deps.simClock?.cadence?.() ?? 60_000;
        await waitFn(ctrl.wait_sim_min * cadence);
        pc++;
        continue;
      }
      pc++;
    }
    return { ok: true, completed_at: wallClock(), trace, bindings: bound };
  }

  return { run, _verbs: Object.keys(VERBS) };
}

function clamp01(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

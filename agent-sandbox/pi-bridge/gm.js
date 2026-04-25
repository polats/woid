/**
 * Game Master — single chokepoint for committing harness-emitted actions.
 *
 * Every action a harness produces flows through here:
 *   1. The verb name is looked up in the registry.
 *   2. Args are validated against the verb's declared schema.
 *   3. The handler runs, applying effects through injected bridge deps.
 *   4. A structured { ok, reason?, effects? } result is returned.
 *
 * Today's verbs mirror the four the bridge already understands —
 * `say`, `move`, `state`, `mood`. This file is the foundation for the
 * full ten-verb set in #225 (adds `say_to`, `face`, `wait`, `emote`,
 * `idle`, `post`); follow-up slices add those and decouple `say` from
 * the Nostr publish path.
 *
 * The GM doesn't import bridge functions directly — they're passed
 * to `createGM` so this file is unit-testable without booting the
 * whole bridge.
 */

const TEXT_LIMIT = 2000;

/**
 * Verb registry — declarative source of truth for what each action
 * looks like and what it does. Each entry:
 *   - args:    object describing field validators (see `validateArgs`).
 *   - effects: keys this verb is documented to mutate. Informational
 *              for now; later phases use it for conflict detection.
 *   - handler: (deps, ctx, args) => Promise<void>. May throw; the GM
 *              catches and returns { ok: false } with the message.
 */
export const VERBS = {
  say: {
    args: {
      text: { type: "string", required: true, max: 1000 },
    },
    effects: ["room.message", "relay.kind1"],
    handler: async (deps, ctx, args) => {
      await deps.publishKind1(ctx.agentId, args.text, ctx.model);
    },
  },

  move: {
    args: {
      x: { type: "number", required: true, integer: true },
      y: { type: "number", required: true, integer: true },
    },
    effects: ["room.position"],
    handler: async (deps, ctx, args) => {
      deps.moveAgent(ctx.agentId, args.x, args.y);
    },
  },

  state: {
    args: {
      value: { type: "string", required: true, max: TEXT_LIMIT },
    },
    effects: ["character.state"],
    handler: async (deps, ctx, args) => {
      deps.saveCharacterManifest(ctx.pubkey, { state: args.value });
    },
  },

  mood: {
    args: {
      value: { type: "object", required: true },
    },
    effects: ["character.mood"],
    handler: async (deps, ctx, args) => {
      const e = args.value.energy;
      const s = args.value.social;
      const next = {};
      if (typeof e === "number" && Number.isFinite(e)) {
        next.energy = clamp(Math.round(e), 0, 100);
      }
      if (typeof s === "number" && Number.isFinite(s)) {
        next.social = clamp(Math.round(s), 0, 100);
      }
      if (Object.keys(next).length === 0) return;
      const c = deps.loadCharacter(ctx.pubkey);
      const merged = { ...(c?.mood || {}), ...next };
      deps.saveCharacterManifest(ctx.pubkey, { mood: merged });
    },
  },
};

/**
 * Create a GM bound to the bridge's commit functions.
 * @param {{
 *   publishKind1: (agentId: string, text: string, model?: string) => Promise<void>,
 *   moveAgent: (agentId: string, x: number, y: number) => void,
 *   saveCharacterManifest: (pubkey: string, patch: object) => void,
 *   loadCharacter: (pubkey: string) => any,
 * }} deps
 */
export function createGM(deps) {
  if (!deps?.publishKind1 || !deps?.moveAgent || !deps?.saveCharacterManifest || !deps?.loadCharacter) {
    throw new Error("createGM: missing dep (publishKind1, moveAgent, saveCharacterManifest, loadCharacter)");
  }

  /**
   * Dispatch a single action.
   *
   * Today's call sites pass actions in the existing keyed shape
   * (`{ type, text }`, `{ type, x, y }`, etc). The GM normalises to
   * `(verbName, args)` internally so the next slice — which adds the
   * `{ verb, args }` shape — only needs to update the normaliser.
   *
   * @param {{ agentId: string, pubkey: string, model?: string }} ctx
   * @param {object} action
   * @returns {Promise<{ ok: boolean, verb?: string, reason?: string }>}
   */
  async function dispatch(ctx, action) {
    if (!action || typeof action !== "object") {
      return { ok: false, reason: "action must be an object" };
    }
    const { verb, args } = normalise(action);
    if (!verb) {
      return { ok: false, reason: "missing verb / type" };
    }
    const def = VERBS[verb];
    if (!def) {
      return { ok: false, verb, reason: `unknown verb "${verb}"` };
    }
    const validation = validateArgs(def.args, args);
    if (!validation.ok) {
      return { ok: false, verb, reason: validation.reason };
    }
    try {
      await def.handler(deps, ctx, validation.args);
      return { ok: true, verb };
    } catch (err) {
      return { ok: false, verb, reason: err?.message || String(err) };
    }
  }

  return { dispatch, verbs: VERBS };
}

// ── helpers ──

/**
 * Map the legacy `{ type, ...flat }` shape into `{ verb, args }`.
 * Specific keys are picked per type so callers can't smuggle extra
 * fields through. Once the new shape lands this becomes a passthrough
 * for `{ verb, args }` and a fallback for the legacy form.
 */
function normalise(action) {
  if (typeof action.verb === "string" && action.args && typeof action.args === "object") {
    return { verb: action.verb, args: action.args };
  }
  if (typeof action.type !== "string") {
    return { verb: null, args: {} };
  }
  switch (action.type) {
    case "say":
      return { verb: "say", args: { text: action.text } };
    case "move":
      return { verb: "move", args: { x: action.x, y: action.y } };
    case "state":
      return { verb: "state", args: { value: action.value } };
    case "mood":
      return { verb: "mood", args: { value: action.value } };
    default:
      return { verb: action.type, args: {} };
  }
}

/**
 * Validate args against a verb's declared schema. Returns the cleaned
 * args (strings trimmed/clipped, numbers rounded) on success.
 */
function validateArgs(schema, raw) {
  if (!schema) return { ok: true, args: {} };
  const out = {};
  const args = raw && typeof raw === "object" ? raw : {};
  for (const [key, rule] of Object.entries(schema)) {
    const v = args[key];
    if (v === undefined || v === null) {
      if (rule.required) return { ok: false, reason: `missing arg "${key}"` };
      continue;
    }
    if (rule.type === "string") {
      if (typeof v !== "string") return { ok: false, reason: `arg "${key}" must be a string` };
      const trimmed = v.trim();
      if (rule.required && trimmed === "") return { ok: false, reason: `arg "${key}" must be non-empty` };
      out[key] = rule.max ? trimmed.slice(0, rule.max) : trimmed;
    } else if (rule.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, reason: `arg "${key}" must be a finite number` };
      out[key] = rule.integer ? Math.round(n) : n;
    } else if (rule.type === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        return { ok: false, reason: `arg "${key}" must be an object` };
      }
      out[key] = v;
    } else {
      out[key] = v;
    }
  }
  return { ok: true, args: out };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

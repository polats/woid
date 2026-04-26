/**
 * Game Master — single chokepoint for committing harness-emitted actions.
 *
 * Every action a harness produces flows through here:
 *   1. The verb name is looked up in the registry.
 *   2. Args are validated against the verb's declared schema.
 *   3. The handler runs, applying effects through injected bridge deps.
 *   4. A structured { ok, reason?, effects? } result is returned.
 *   5. Perception events are emitted to scene-mates when applicable
 *      (slice 3 + 4: speech, movement go through the perception store).
 *
 * Slice 2 of #225 grew the registry to the full ten-verb set; slice
 * 3 + 4 add scene-aware perception emission and `say_to` validation
 * against scene-mate membership.
 *
 *   say(text)                  — speak in the room. Colyseus only, no relay.
 *                                Emits a speech event to scene-mates.
 *   say_to(recipient, text)    — addressed speech. Validates the recipient
 *                                is resolvable + in scene with the actor.
 *                                Emits an addressed speech event.
 *   move(x, y)                 — set position on the grid. Emits a movement
 *                                event to characters who were nearby BEFORE
 *                                the move (so they see "X walked past me").
 *   face(target)               — turn toward an agent or coordinate.
 *                                Records intent; no state mutation yet.
 *   wait(seconds?)             — explicit pass-time. Pure intent record.
 *   emote(kind)                — gesture / expression. Records intent;
 *                                renderer can switch on it later.
 *   set_state(value)           — patch the character's `state` field.
 *   set_mood(energy?, social?) — patch the character's mood vector.
 *   post(text)                 — public social post → Nostr kind:1.
 *                                The only verb that publishes to the relay.
 *                                Doesn't emit room perception (it's offstage).
 *   idle                       — explicit no-op.
 *
 * Legacy verb names (`state`, `mood`) are still accepted via the normaliser
 * so older characters and parsers don't break.
 *
 * The GM doesn't import bridge functions directly — they're passed
 * to `createGM` so this file is unit-testable without booting the
 * whole bridge. `perception` and `getSnapshot` are optional so tests
 * can opt out; production wires them.
 */
import { sceneMatesOf as rawSceneMatesOf, inScene as rawInScene, resolveRecipient } from "./scenes.js";

const SAY_LIMIT = 1000;
const POST_LIMIT = 1000;
const STATE_LIMIT = 2000;
const RECIPIENT_LIMIT = 200;
const EMOTE_LIMIT = 80;
const TARGET_LIMIT = 200;
const WAIT_MIN = 0;
const WAIT_MAX = 600;

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
    args: { text: { type: "string", required: true, max: SAY_LIMIT } },
    effects: ["room.message", "perception.speech"],
    handler: async (deps, ctx, args) => {
      deps.roomSay(ctx.agentId, args.text);
      const snapshot = (ctx?.snapshot ?? deps.getSnapshot?.());
      const mates = deps.sceneMatesOf(snapshot, ctx.pubkey);
      if (mates.length > 0) {
        deps.perception?.broadcastTo?.(
          mates,
          {
            kind: "speech",
            from_pubkey: ctx.pubkey,
            from_name: ctx.name,
            text: args.text,
          },
          ctx.pubkey,
        );
      }
    },
  },

  say_to: {
    args: {
      recipient: { type: "string", required: true, max: RECIPIENT_LIMIT },
      text: { type: "string", required: true, max: SAY_LIMIT },
    },
    effects: ["room.message", "perception.speech"],
    handler: async (deps, ctx, args) => {
      const snapshot = (ctx?.snapshot ?? deps.getSnapshot?.());
      const recipientPubkey = resolveRecipient(snapshot, args.recipient);
      if (!recipientPubkey) {
        throw new Error(`recipient "${args.recipient}" not found in room`);
      }
      if (!deps.inScene(snapshot, ctx.pubkey, recipientPubkey)) {
        throw new Error(`recipient "${args.recipient}" not in scene with you`);
      }
      const recipientName = findName(snapshot, recipientPubkey) ?? args.recipient;
      const formatted = `@${recipientName} ${args.text}`.slice(0, SAY_LIMIT);
      deps.roomSay(ctx.agentId, formatted);

      const mates = deps.sceneMatesOf(snapshot, ctx.pubkey);
      if (mates.length > 0) {
        deps.perception?.broadcastTo?.(
          mates,
          {
            kind: "speech",
            from_pubkey: ctx.pubkey,
            from_name: ctx.name,
            text: args.text,
            addressed_to_npub: recipientPubkey,
            addressed_to_name: recipientName,
          },
          ctx.pubkey,
        );
      }
    },
  },

  move: {
    args: {
      x: { type: "number", required: true, integer: true },
      y: { type: "number", required: true, integer: true },
    },
    effects: ["room.position", "perception.movement"],
    handler: async (deps, ctx, args) => {
      // Capture the pre-move snapshot so "people who were nearby" see
      // the movement event even if the agent walks out of their scene.
      const snapshot = (ctx?.snapshot ?? deps.getSnapshot?.());
      const matesBefore = deps.sceneMatesOf(snapshot, ctx.pubkey);
      deps.moveAgent(ctx.agentId, args.x, args.y);
      if (matesBefore.length > 0) {
        deps.perception?.broadcastTo?.(
          matesBefore,
          {
            kind: "movement",
            who_pubkey: ctx.pubkey,
            who_name: ctx.name,
            x: args.x,
            y: args.y,
          },
          ctx.pubkey,
        );
      }
    },
  },

  face: {
    args: { target: { type: "string", required: true, max: TARGET_LIMIT } },
    effects: [],
    handler: async () => {
      // Intent only. Future slice will store `facing` on AgentPresence
      // and broadcast it through the room schema.
    },
  },

  wait: {
    args: { seconds: { type: "number", required: false, min: WAIT_MIN, max: WAIT_MAX } },
    effects: [],
    handler: async () => {
      // Intent only. The orchestrator (slice 5) honours the duration when
      // pacing the next turn.
    },
  },

  emote: {
    args: { kind: { type: "string", required: true, max: EMOTE_LIMIT } },
    effects: [],
    handler: async () => {
      // Intent only. Renderer hook lands later.
    },
  },

  set_state: {
    args: { value: { type: "string", required: true, max: STATE_LIMIT } },
    effects: ["character.state"],
    handler: async (deps, ctx, args) => {
      deps.saveCharacterManifest(ctx.pubkey, { state: args.value });
    },
  },

  set_mood: {
    args: {
      energy: { type: "number", required: false, min: 0, max: 100, integer: true },
      social: { type: "number", required: false, min: 0, max: 100, integer: true },
    },
    effects: ["character.mood", "needs.energy", "needs.social"],
    handler: async (deps, ctx, args) => {
      const next = {};
      if (typeof args.energy === "number") next.energy = args.energy;
      if (typeof args.social === "number") next.social = args.social;
      if (Object.keys(next).length === 0) return;
      // Mirror to the needs tracker so the same value is the source of
      // truth for both the LLM-facing mood vector and the server-side
      // decay loop. Optional dep — falls through silently if not wired.
      if (deps.needsTracker?.setAxis) {
        if (typeof next.energy === "number") deps.needsTracker.setAxis(ctx.pubkey, "energy", next.energy);
        if (typeof next.social === "number") deps.needsTracker.setAxis(ctx.pubkey, "social", next.social);
      }
      const c = deps.loadCharacter(ctx.pubkey);
      const merged = { ...(c?.mood || {}), ...next };
      deps.saveCharacterManifest(ctx.pubkey, { mood: merged });
    },
  },

  post: {
    args: { text: { type: "string", required: true, max: POST_LIMIT } },
    effects: ["relay.kind1"],
    handler: async (deps, ctx, args) => {
      await deps.relayPost(ctx.agentId, args.text, ctx.model);
    },
  },

  idle: {
    args: {},
    effects: [],
    handler: async () => {
      // Pure no-op. Recorded in the action log for honest accounting.
    },
  },
};

/**
 * Create a GM bound to the bridge's commit functions.
 * @param {{
 *   roomSay: (agentId: string, content: string) => void,
 *   relayPost: (agentId: string, content: string, modelTag?: string) => Promise<any>,
 *   moveAgent: (agentId: string, x: number, y: number) => void,
 *   saveCharacterManifest: (pubkey: string, patch: object) => void,
 *   loadCharacter: (pubkey: string) => any,
 * }} deps
 */
export function createGM(deps) {
  const required = ["roomSay", "relayPost", "moveAgent", "saveCharacterManifest", "loadCharacter"];
  for (const k of required) {
    if (typeof deps?.[k] !== "function") {
      throw new Error(`createGM: missing dep "${k}"`);
    }
  }
  // Optional cooldown-aware scene helpers. Injected by the scene
  // tracker in production; tests fall back to the raw scenes.js
  // helpers (no cooldowns). Patched onto deps so the module-scoped
  // verb handlers can reach them via their `deps` arg.
  if (typeof deps.sceneMatesOf !== "function") deps.sceneMatesOf = rawSceneMatesOf;
  if (typeof deps.inScene !== "function") deps.inScene = rawInScene;

  /**
   * Dispatch a single action.
   *
   * Accepts both shapes:
   *   - Legacy keyed: { type: "say", text: "hi" }, { type: "mood", value: {...} }
   *   - New structured: { verb: "say", args: { text: "hi" } }
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
      // Return the cleaned args alongside the verb so callers (journal,
      // turn log) can record the canonical post-validation form.
      return { ok: true, verb, args: validation.args };
    } catch (err) {
      return { ok: false, verb, reason: err?.message || String(err) };
    }
  }

  return { dispatch, verbs: VERBS };
}

// ── helpers ──

/**
 * Map any input shape into `{ verb, args }`.
 *
 * Order:
 *   1. New structured shape `{ verb, args }` → passthrough.
 *   2. Legacy keyed shape `{ type, ...flat }` → mapped per type.
 *   3. Anything else → `{ verb: null }` so dispatch returns a rejection.
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
    case "say_to":
      return { verb: "say_to", args: { recipient: action.recipient, text: action.text } };
    case "move":
      return { verb: "move", args: { x: action.x, y: action.y } };
    case "face":
      return { verb: "face", args: { target: action.target } };
    case "wait":
      return { verb: "wait", args: action.seconds !== undefined ? { seconds: action.seconds } : {} };
    case "emote":
      return { verb: "emote", args: { kind: action.kind } };
    case "post":
      return { verb: "post", args: { text: action.text } };
    case "idle":
      return { verb: "idle", args: {} };
    // Legacy aliases — older harnesses and tests emit these names.
    case "state":
      return { verb: "set_state", args: { value: action.value } };
    case "mood":
      return {
        verb: "set_mood",
        args: action.value && typeof action.value === "object"
          ? { energy: action.value.energy, social: action.value.social }
          : {},
      };
    default:
      return { verb: action.type, args: {} };
  }
}

/**
 * Validate args against a verb's declared schema. Returns the cleaned
 * args (strings trimmed/clipped, numbers rounded/clamped) on success.
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
      let cleaned = rule.integer ? Math.round(n) : n;
      if (typeof rule.min === "number") cleaned = Math.max(rule.min, cleaned);
      if (typeof rule.max === "number") cleaned = Math.min(rule.max, cleaned);
      out[key] = cleaned;
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

function findName(snapshot, pubkey) {
  if (!snapshot) return null;
  for (const a of snapshot.agents ?? []) {
    if (a?.npub === pubkey) return a.name ?? null;
  }
  return null;
}

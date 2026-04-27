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
import { OBJECT_TYPES } from "./objects.js";

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
 *   - prompt:  one-line description used to auto-generate the verbs
 *              section of the system prompt. Keep terse; rules /
 *              philosophy live in buildContext.js.
 *   - handler: (deps, ctx, args) => Promise<void>. May throw; the GM
 *              catches and returns { ok: false } with the message.
 *
 * Adding a verb is a single-file edit — the prompt section auto-
 * regenerates from this registry on the next bridge boot.
 */
export const VERBS = {
  say: {
    args: { text: { type: "string", required: true, max: SAY_LIMIT } },
    effects: ["room.message", "perception.speech"],
    prompt: "speak in the room. Heard by anyone present. NOT broadcast publicly.",
    piExample: `.pi/skills/post/scripts/post.sh "your message"`,
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
    prompt: "addressed speech. ONLY works for someone in scene with you. If they're farther away, use `move` to get closer first or `say` (which everyone in the room hears).",
    handler: async (deps, ctx, args) => {
      const snapshot = (ctx?.snapshot ?? deps.getSnapshot?.());
      const recipientPubkey = resolveRecipient(snapshot, args.recipient);
      if (!recipientPubkey) {
        throw new Error(`recipient "${args.recipient}" not found in room`);
      }
      if (recipientPubkey === ctx.pubkey) {
        // Talking to yourself in say_to bounces a speech perception
        // back into your own stream and can spiral into a self-reply
        // loop. Prefer set_state / a journal note for inner monologue.
        throw new Error("you can't say_to yourself — use set_state or just say if you want to think out loud");
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
    prompt: "walk to tile (x,y) within the room bounds.",
    piExample: `.pi/skills/room/scripts/room.sh move 4 5`,
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
    prompt: "turn toward another character or position.",
    handler: async () => {
      // Intent only. Future slice will store `facing` on AgentPresence
      // and broadcast it through the room schema.
    },
  },

  wait: {
    args: { seconds: { type: "number", required: false, min: WAIT_MIN, max: WAIT_MAX } },
    effects: [],
    prompt: "pass time without speaking. Useful for letting silence sit.",
    handler: async () => {
      // Intent only. The orchestrator (slice 5) honours the duration when
      // pacing the next turn.
    },
  },

  emote: {
    args: { kind: { type: "string", required: true, max: EMOTE_LIMIT } },
    effects: [],
    prompt: "gesture or expression (e.g. shrug, nod, smile, sigh).",
    handler: async () => {
      // Intent only. Renderer hook lands later.
    },
  },

  set_state: {
    args: { value: { type: "string", required: true, max: STATE_LIMIT } },
    effects: ["character.state"],
    prompt: "update your own short mood/context note (private, persistent across turns).",
    piExample: `.pi/skills/state/scripts/update.sh "new mood"`,
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
    prompt: "adjust your energy / social need axes directly (0–100 each). Other axes drift on their own.",
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

  feel: {
    args: {
      tag: { type: "string", required: true, max: 64 },
      weight: { type: "number", required: true, min: -5, max: 5, integer: true },
      reason: { type: "string", required: false, max: 200 },
      duration_sim_min: { type: "number", required: false, min: 1, max: 24 * 60 * 7, integer: true },
    },
    effects: ["character.moodlet"],
    prompt: "register a feeling on yourself in response to what just happened — a moodlet with a short tag (e.g. \"felt_seen\", \"miffed\", \"warmed_up\"), a weight in [-5, +5], a brief reason, and an optional duration in sim-minutes (default ~2 sim-hours). Use sparingly: only when the moment genuinely shifted how you feel.",
    handler: async (deps, ctx, args) => {
      if (!deps.moodletsTracker?.emit) return;
      let durationMs;
      if (Number.isFinite(args.duration_sim_min) && deps.simClock?.cadence) {
        durationMs = args.duration_sim_min * deps.simClock.cadence();
      }
      const m = deps.moodletsTracker.emit(ctx.pubkey, {
        tag: args.tag,
        weight: args.weight,
        reason: args.reason || "",
        source: "self",
        duration_ms: durationMs,
      });
      if (m) {
        deps.perception?.appendOne?.(ctx.pubkey, {
          kind: "moodlet_added",
          tag: m.tag,
          weight: m.weight,
          reason: m.reason || null,
        });
      }
    },
  },

  post: {
    args: {
      text: { type: "string", required: true, max: POST_LIMIT },
      image_prompt: { type: "string", required: false, max: 400 },
    },
    effects: ["relay.kind1", "image.gen"],
    prompt: "public social post → goes to your Nostr followers' feeds. RARE and DELIBERATE — only when worth broadcasting beyond the room. Pass an optional image_prompt to attach a generated photograph (mundane and specific in good light beats dramatic landscapes; describe what's in frame).",
    handler: async (deps, ctx, args) => {
      let extraTags;
      let content = args.text;
      if (args.image_prompt && args.image_prompt.trim() && deps.generatePostImage) {
        // Per-character cooldown so a runaway LLM can't chew through
        // FLUX credits. Sim-time-aware: 60 sim-min between images.
        const lastAt = deps.imagePostCooldown?.get?.(ctx.pubkey) ?? 0;
        const nowSim = deps.simClock?.now?.()?.real_ms ?? Date.now();
        const cadence = deps.simClock?.cadence?.() ?? 60_000;
        const cooldownMs = 60 * cadence; // 60 sim-min
        if (nowSim - lastAt < cooldownMs) {
          // Post the text without the image; surface a perception so
          // the LLM knows why the image didn't go through.
          deps.perception?.appendOne?.(ctx.pubkey, {
            kind: "image_post_throttled",
            reason: "you're cooling down on photographs — give it some sim-time",
          });
        } else {
          try {
            const img = await deps.generatePostImage({
              pubkey: ctx.pubkey,
              prompt: args.image_prompt,
            });
            content = `${args.text}\n\n${img.url}`;
            extraTags = [
              ["imeta", `url ${img.url}`, `m ${img.mime}`, `x ${img.sha256}`],
            ];
            deps.imagePostCooldown?.set?.(ctx.pubkey, nowSim);
          } catch (err) {
            console.warn(`[post:image] ${ctx.pubkey.slice(0, 8)} — ${err?.message || err}`);
            // Fall through with text-only post.
            deps.perception?.appendOne?.(ctx.pubkey, {
              kind: "image_post_failed",
              reason: err?.message?.slice(0, 120) || "image gen unavailable",
            });
          }
        }
      }
      const event = await deps.relayPost(ctx.agentId, content, ctx.model, extraTags);
      // Return shape carries image fields so the session-event hook
      // in server.js can include them in the recap window.
      return {
        ok: true,
        verb: "post",
        args: extraTags
          ? { text: args.text, image_prompt: args.image_prompt, image_url: extraTags[0][1].slice(4) }
          : { text: args.text },
        event_id: event?.id,
      };
    },
  },

  idle: {
    args: {},
    effects: [],
    prompt: "explicit no-op. Use when you genuinely have nothing to do.",
    handler: async () => {
      // Pure no-op. Recorded in the action log for honest accounting.
    },
  },

  follow: {
    args: {
      target_pubkey: { type: "string", required: true, max: 64 },
    },
    effects: ["relay.kind3"],
    prompt: "follow another character on Nostr (kind:3 contact list update). Use after a meaningful first meeting.",
    handler: async (deps, ctx, args) => {
      const target = String(args.target_pubkey || "").trim();
      if (!/^[0-9a-f]{64}$/i.test(target)) return { ok: false, reason: "target_pubkey must be 64-char hex" };
      if (target === ctx.pubkey) return { ok: false, reason: "cannot follow yourself" };
      const c = deps.loadCharacter(ctx.pubkey);
      if (!c) return { ok: false, reason: "your character record is gone" };
      const next = [...new Set([...(c.follows || []), target])];
      deps.saveCharacterManifest(ctx.pubkey, { follows: next });
      try { await deps.publishCharacterFollows?.(ctx.pubkey); }
      catch (err) { console.warn(`[follow] kind:3 publish failed: ${err?.message}`); }
      // Emit perception on the followed character so they see it next turn.
      deps.perception?.appendOne?.(target, {
        kind: "follow_received",
        from_pubkey: ctx.pubkey,
        from_name: ctx.name,
      });
      // Subscribe this follower to the followee's kind:1 stream so future
      // posts surface as `post_seen` perception events. The bridge keeps
      // this subscription open across turns; no per-turn cost.
      try { deps.subscribeToFollowee?.(ctx.pubkey, target); }
      catch (err) { console.warn(`[follow] subscribe failed: ${err?.message}`); }
      return { ok: true, verb: "follow", args: { target_pubkey: target, target_name: deps.loadCharacter(target)?.name || null } };
    },
  },

  reply: {
    args: {
      to_event_id: { type: "string", required: true, max: 64 },
      text: { type: "string", required: true, max: POST_LIMIT },
      to_pubkey: { type: "string", required: false, max: 64 },
      image_prompt: { type: "string", required: false, max: 400 },
    },
    effects: ["relay.kind1"],
    prompt: "reply publicly to a post you've seen (NIP-10 reply chain). Don't reply to everything — only when you have something specific to say. Pass an optional image_prompt to attach a generated photograph.",
    handler: async (deps, ctx, args) => {
      const eid = String(args.to_event_id || "").trim();
      if (!/^[0-9a-f]{64}$/i.test(eid)) return { ok: false, reason: "to_event_id must be 64-char hex" };
      const tags = [["e", eid, "", "reply"]];
      if (args.to_pubkey && /^[0-9a-f]{64}$/i.test(args.to_pubkey)) {
        tags.push(["p", args.to_pubkey]);
      }
      let content = args.text;
      if (args.image_prompt && args.image_prompt.trim() && deps.generatePostImage) {
        try {
          const img = await deps.generatePostImage({ pubkey: ctx.pubkey, prompt: args.image_prompt });
          content = `${args.text}\n\n${img.url}`;
          tags.push(["imeta", `url ${img.url}`, `m ${img.mime}`, `x ${img.sha256}`]);
        } catch (err) {
          console.warn(`[reply:image] ${ctx.pubkey.slice(0, 8)} — ${err?.message || err}`);
        }
      }
      const event = await deps.relayPost(ctx.agentId, content, ctx.model, tags);
      return {
        ok: true,
        verb: "reply",
        args: {
          to_event_id: eid,
          to_pubkey: args.to_pubkey || null,
          text: args.text,
          image_url: tags.find((t) => t[0] === "imeta")?.[1]?.slice(4) || null,
        },
        event_id: event?.id,
      };
    },
  },

  use: {
    args: {
      object_id: { type: "string", required: true, max: 64 },
    },
    effects: ["object.state", "needs.*", "moodlet.add"],
    prompt: "interact with a smart object you can see (use its id). Beds restore energy and skip you to morning; the fridge has leftovers; chairs let you sit.",
    handler: async (deps, ctx, args) => {
      if (!deps.objectsRegistry) return { ok: false, reason: "objects unavailable" };
      const inst = deps.objectsRegistry.get(args.object_id);
      if (!inst) return { ok: false, reason: `unknown object: ${args.object_id}` };
      const type = OBJECT_TYPES[inst.type];
      if (!type) return { ok: false, reason: `unknown type: ${inst.type}` };
      const affordance = type.affordances?.[0];
      if (!affordance) return { ok: false, reason: `${inst.type} has no affordances` };

      // Locate the agent on the map for adjacency check.
      const snapshot = ctx?.snapshot ?? deps.getSnapshot?.();
      const me = (snapshot?.agents || []).find((a) => a.npub === ctx.pubkey);
      const myX = Number.isFinite(me?.x) ? me.x : null;
      const myY = Number.isFinite(me?.y) ? me.y : null;

      // Validate preconditions.
      for (const pre of affordance.preconditions || []) {
        if (pre === "adjacent") {
          if (myX == null || myY == null) {
            return { ok: false, reason: "not on the map" };
          }
          const dx = Math.abs(inst.x - myX);
          const dy = Math.abs(inst.y - myY);
          if (Math.max(dx, dy) > 1) {
            return {
              ok: false,
              reason: `not adjacent to ${inst.type} at (${inst.x}, ${inst.y}) — you're at (${myX}, ${myY}). Move closer first.`,
            };
          }
        }
        if (pre === "free") {
          if (inst.state?.occupant) {
            return { ok: false, reason: `${inst.type} is in use by someone else` };
          }
        }
      }

      // Apply effects in declared order.
      for (const eff of affordance.effects || []) {
        switch (eff.kind) {
          case "occupy":
            deps.objectsRegistry.patchState(inst.id, { occupant: ctx.pubkey });
            break;
          case "instance":
            if (eff.field) {
              const next = eff.op === "=" ? eff.value : (inst.state?.[eff.field] ?? null);
              deps.objectsRegistry.patchState(inst.id, { [eff.field]: next });
            }
            break;
          case "need":
            if (deps.needsTracker?.setAxis && deps.needsTracker?.adjust) {
              if (eff.op === "=") {
                deps.needsTracker.setAxis(ctx.pubkey, eff.axis, eff.amount);
              } else if (eff.op === "+") {
                deps.needsTracker.adjust(ctx.pubkey, eff.axis, +eff.amount);
              } else if (eff.op === "-") {
                deps.needsTracker.adjust(ctx.pubkey, eff.axis, -eff.amount);
              }
            }
            break;
          case "moodlet":
            if (deps.moodletsTracker?.emit) {
              // duration_sim_min translates to real-ms via the active
              // sim-clock cadence. Falls back to 4h if no sim-clock.
              let durationMs = undefined;
              if (Number.isFinite(eff.duration_sim_min) && deps.simClock?.cadence) {
                durationMs = eff.duration_sim_min * deps.simClock.cadence();
              } else if (Number.isFinite(eff.duration_ms)) {
                durationMs = eff.duration_ms;
              }
              deps.moodletsTracker.emit(ctx.pubkey, {
                tag: eff.tag,
                weight: eff.weight ?? 0,
                reason: eff.reason || "",
                source: "card",
                duration_ms: durationMs,
              });
            }
            break;
          case "advance_sim":
            // Sleep skips boring sim-time forward. Solo-character demo
            // path; revisit when multi-character days have to coexist.
            if (deps.simClock?.advance && Number.isFinite(eff.sim_minutes)) {
              deps.simClock.advance(eff.sim_minutes * 60_000);
            }
            break;
        }
      }

      // Perception event for scene-mates so they witness the action.
      const matesPubkeys = deps.sceneMatesOf?.(snapshot, ctx.pubkey) || [];
      if (matesPubkeys.length > 0) {
        deps.perception?.broadcastTo?.(
          matesPubkeys,
          {
            kind: "object_used",
            who_pubkey: ctx.pubkey,
            who_name: ctx.name,
            object_id: inst.id,
            object_type: inst.type,
            verb: affordance.verb,
          },
          ctx.pubkey,
        );
      }

      return {
        ok: true,
        verb: "use",
        args: { object_id: inst.id, object_type: inst.type, affordance: affordance.verb },
      };
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
      const handlerResult = await def.handler(deps, ctx, validation.args);
      // If the handler returned a richer result object (e.g. post with
      // image_url, follow with resolved target_name), merge it over the
      // default shape so session-event recorders see the canonical
      // post-execution form. Plain undefined / void = use defaults.
      if (handlerResult && typeof handlerResult === "object") {
        return { ok: true, verb, args: validation.args, ...handlerResult };
      }
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

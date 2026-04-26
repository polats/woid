/**
 * Scene tracker — stateful layer over the pure proximity helpers in
 * scenes.js. Provides the conversation gate that prevents two
 * characters in proximity from running away with LLM calls forever.
 *
 * A "scene" here is a pair-bond between two characters who are within
 * SCENE_RADIUS tiles AND not on cooldown. Three+ characters in
 * proximity produce multiple overlapping pair scenes (A-B, A-C, B-C).
 *
 * Scene lifecycle:
 *   open   — first time a pair becomes proximate while not on cooldown
 *   close  — proximity lost, OR turn budget reached, OR soft-stop, OR
 *            hard cap. On close, the pair enters cooldown.
 *
 * Cooldown effect: the pair is treated as "not in scene" by the GM
 * and scheduler. say_to fails with the structured rejection; speech
 * perception broadcasts skip the cooldown'd peer; the heartbeat
 * scheduler reverts to alone-cadence. The pair effectively "drifts
 * apart" in the simulation even if their tiles haven't moved.
 *
 * The four close conditions:
 *   - budget        — turns of speech in this scene reached the
 *                     per-scene budget (random 4-8). Early ceiling.
 *   - soft_stop     — both participants emit `wait` or `idle` for
 *                     SOFT_STOP_RUN consecutive turns. Quiet exit.
 *   - hard_cap      — turns reached HARD_CAP regardless of budget.
 *                     Worst-case ceiling against runaway.
 *   - proximity_lost — at least one participant moved out of radius.
 *
 * The tracker exports two "effective" helpers (`effectiveInScene`,
 * `effectiveSceneMatesOf`) that wrap the pure scenes.js helpers and
 * subtract cooldown'd pairs. The GM and scheduler use these instead
 * of the raw versions; tests can opt out by injecting raw fns.
 */

import { sceneMatesOf as rawSceneMatesOf, inScene as rawInScene } from "./scenes.js";

export const DEFAULTS = {
  budgetMin: 4,
  budgetMax: 8,
  hardCap: 12,
  cooldownMs: 5 * 60 * 1000,
  softStopRun: 2,
};

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Create a tracker. All cfg knobs are overridable for tests.
 *
 * @param {Partial<typeof DEFAULTS> & { now?: () => number, random?: () => number }} [opts]
 */
export function createSceneTracker(opts = {}) {
  // Only overlay defined fields so callers passing { budgetMin: undefined }
  // (e.g. from `Number(process.env.X) || undefined`) don't blow away the
  // default. `null` is treated as "use default" too.
  const cleaned = Object.fromEntries(
    Object.entries(opts).filter(([, v]) => v !== undefined && v !== null && !(typeof v === "number" && Number.isNaN(v))),
  );
  const cfg = { ...DEFAULTS, ...cleaned };
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;

  /** @type {Map<string, { sceneId: string, participants: [string, string], startedAt: number, turns: number, budget: number }>} */
  const scenes = new Map();
  /** @type {Map<string, number>} pair-key → cooldown until (ms epoch) */
  const cooldowns = new Map();
  /** @type {Map<string, number>} pubkey → consecutive quiet-action run */
  const quietRuns = new Map();

  function rollBudget() {
    const range = cfg.budgetMax - cfg.budgetMin;
    return cfg.budgetMin + Math.floor(random() * (range + 1));
  }

  function isOnCooldown(a, b) {
    if (!a || !b || a === b) return false;
    const until = cooldowns.get(pairKey(a, b));
    return until != null && until > now();
  }

  function startCooldown(a, b) {
    cooldowns.set(pairKey(a, b), now() + cfg.cooldownMs);
  }

  /**
   * Sync internal scene state with current snapshot. Call before each
   * dispatch / heartbeat so newly-formed proximity opens scenes and
   * lost proximity closes them.
   *
   * @param {{ agents?: Array<{ npub?: string, x?: number, y?: number }> }} snapshot
   * @returns {{ opened: Array<object>, closed: Array<object> }}
   */
  function onSnapshot(snapshot) {
    const opened = [];
    const closed = [];
    const agents = snapshot?.agents ?? [];

    // Find current proximity pairs — same Chebyshev rule scenes.js uses.
    const proxPairs = new Set();
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i], b = agents[j];
        if (!a?.npub || !b?.npub) continue;
        if (rawInScene(snapshot, a.npub, b.npub)) {
          proxPairs.add(pairKey(a.npub, b.npub));
        }
      }
    }

    // Close scenes that lost proximity.
    for (const [key, scene] of [...scenes]) {
      if (!proxPairs.has(key)) {
        scenes.delete(key);
        startCooldown(scene.participants[0], scene.participants[1]);
        closed.push({ ...scene, reason: "proximity_lost" });
      }
    }

    // Open new scenes for newly-proximate pairs (not on cooldown).
    for (const key of proxPairs) {
      if (scenes.has(key)) continue;
      const [a, b] = key.split("|");
      if (isOnCooldown(a, b)) continue;
      const scene = {
        sceneId: `scene_${now()}_${random().toString(36).slice(2, 8)}`,
        participants: [a, b],
        startedAt: now(),
        turns: 0,
        budget: rollBudget(),
      };
      scenes.set(key, scene);
      opened.push({ ...scene });
    }

    return { opened, closed };
  }

  function activeScenesFor(pubkey) {
    const out = [];
    for (const scene of scenes.values()) {
      if (scene.participants.includes(pubkey)) out.push(scene);
    }
    return out;
  }

  /**
   * Record an action emitted by `actor`. Updates per-scene turn count,
   * tracks soft-stop runs, and closes scenes whose budget / hard cap /
   * soft-stop trigger fired. Returns the closed scenes for caller-side
   * logging or perception broadcasts.
   *
   * @param {string} actor
   * @param {string} verb
   * @returns {Array<{ sceneId: string, participants: [string, string], reason: string }>}
   */
  function recordAction(actor, verb) {
    const isQuiet = verb === "wait" || verb === "idle";
    const isSpeech = verb === "say" || verb === "say_to";

    if (isQuiet) {
      quietRuns.set(actor, (quietRuns.get(actor) ?? 0) + 1);
    } else {
      // Anything non-quiet (speech, movement, post, etc.) resets the run.
      quietRuns.set(actor, 0);
    }

    const closedThisTurn = [];

    for (const scene of activeScenesFor(actor)) {
      if (isSpeech) scene.turns += 1;

      let reason = null;
      if (scene.turns >= cfg.hardCap) {
        reason = "hard_cap";
      } else if (scene.turns >= scene.budget) {
        reason = "budget";
      } else {
        const [pA, pB] = scene.participants;
        const qa = quietRuns.get(pA) ?? 0;
        const qb = quietRuns.get(pB) ?? 0;
        if (qa >= cfg.softStopRun && qb >= cfg.softStopRun) reason = "soft_stop";
      }

      if (reason) {
        const key = pairKey(scene.participants[0], scene.participants[1]);
        scenes.delete(key);
        startCooldown(scene.participants[0], scene.participants[1]);
        closedThisTurn.push({ ...scene, reason });
      }
    }

    return closedThisTurn;
  }

  /**
   * Drop all scenes containing `pubkey`. Called when an agent stops.
   * Doesn't set cooldowns — the character is gone.
   */
  function clearCharacter(pubkey) {
    for (const [key, scene] of [...scenes]) {
      if (scene.participants.includes(pubkey)) scenes.delete(key);
    }
    quietRuns.delete(pubkey);
  }

  // ── effective helpers (cooldown-aware wrappers over scenes.js raw) ──

  function effectiveInScene(snapshot, a, b, radius) {
    if (isOnCooldown(a, b)) return false;
    return rawInScene(snapshot, a, b, radius);
  }

  function effectiveSceneMatesOf(snapshot, pubkey, radius) {
    const raw = rawSceneMatesOf(snapshot, pubkey, radius);
    return raw.filter((other) => !isOnCooldown(pubkey, other));
  }

  function snapshotState() {
    return {
      scenes: [...scenes.values()],
      cooldowns: [...cooldowns.entries()].map(([key, until]) => ({
        pair: key,
        until,
        msRemaining: Math.max(0, until - now()),
      })),
      quietRuns: [...quietRuns.entries()].map(([k, v]) => ({ pubkey: k, run: v })),
    };
  }

  return {
    onSnapshot,
    recordAction,
    activeScenesFor,
    isOnCooldown,
    clearCharacter,
    effectiveInScene,
    effectiveSceneMatesOf,
    snapshot: snapshotState,
  };
}

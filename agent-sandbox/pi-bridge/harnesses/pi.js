/**
 * PiHarness — wraps the long-lived pi-pool (`../pi-pool.js`) behind the
 * common Harness interface. Behaviourally identical to the pre-harness
 * world: pi receives a prompt, chooses to act via its bash tool, post.sh
 * curls /internal/post, and the bridge commits the action.
 *
 * Returns `actions: []` from turn() because pi already committed its
 * side effects during the bash loopback. The inspector still renders
 * every pi event via onEvent; that's where the visible work shows up.
 */

import * as piPool from "../pi-pool.js";

/**
 * @param {Object} deps
 * @param {(id: string) => any} [deps.getPi]
 * @param {(opts: any) => any} [deps.startPi]
 * @param {(id: string) => boolean} [deps.stopPi]
 * @param {(id: string, patch: any) => any} [deps.restartHandle]
 * @returns {import('./types.js').Harness}
 */
export function createPiHarness(deps = {}) {
  const startFn = deps.startPi ?? piPool.startPi;
  const getFn = deps.getPi ?? piPool.getPi;
  const stopFn = deps.stopPi ?? piPool.stopPi;
  const restartFn = deps.restartHandle ?? piPool.restartHandle;

  let agentId = null;
  let systemPromptSignature = null;
  let turns = 0;
  let currentPrompt = null;
  let currentProvider = null;
  let currentModel = null;
  let currentSessionPath = null;
  let currentCwd = null;
  let currentEnv = null;
  let onEvent = () => {};

  const harness = {
    name: "pi",

    /** @param {import('./types.js').StartOpts} opts */
    async start(opts) {
      agentId = opts.agentId;
      systemPromptSignature = opts.systemPrompt;
      currentPrompt = opts.systemPrompt;
      currentProvider = opts.provider;
      currentModel = opts.model;
      currentSessionPath = opts.sessionPath;
      currentCwd = opts.cwd;
      currentEnv = opts.env;
      onEvent = opts.onEvent || (() => {});
      // Lazy spawn on first turn — matches the pre-harness behaviour and
      // avoids paying cold start if the bridge decides to stopAgent
      // between create and first trigger.
    },

    /** @param {string} userTurn */
    async turn(userTurn) {
      if (!agentId) throw new Error("pi harness not started");

      // If the system prompt has drifted since last turn (character
      // edited mid-session), restart the handle. Session file persists,
      // so pi sees the new prompt on top of existing history.
      let handle = getFn(agentId);
      if (handle && systemPromptSignature && systemPromptSignature !== currentPrompt) {
        handle = restartFn(agentId, { systemPrompt: currentPrompt });
        systemPromptSignature = currentPrompt;
      }
      if (!handle) {
        handle = startFn({
          agentId,
          provider: currentProvider,
          model: currentModel,
          sessionPath: currentSessionPath,
          systemPrompt: currentPrompt,
          cwd: currentCwd,
          env: currentEnv,
          onEvent: (ev) => onEvent({ kind: "pi", data: ev }),
        });
        systemPromptSignature = currentPrompt;
      }

      onEvent({ kind: "turn_start", data: { harness: "pi" } });
      try {
        const result = await handle.turn(userTurn);
        turns += 1;
        const msg = result?.message;
        const parts = Array.isArray(msg?.content) ? msg.content : [];
        const thinking = parts
          .filter((p) => p?.type === "thinking")
          .map((p) => p.thinking || "")
          .join("");
        const usage = msg?.usage
          ? {
              input: msg.usage.input,
              output: msg.usage.output,
              totalTokens: msg.usage.totalTokens,
              cost: msg.usage.cost?.total,
            }
          : undefined;
        onEvent({ kind: "turn_end", data: { harness: "pi" } });
        return { actions: [], thinking, usage };
      } catch (err) {
        onEvent({ kind: "error", data: { message: err?.message || String(err) } });
        throw err;
      }
    },

    updateSystemPrompt(next) {
      currentPrompt = next;
    },

    async stop() {
      if (!agentId) return;
      stopFn(agentId);
    },

    snapshot() {
      const h = agentId ? getFn(agentId) : null;
      const s = h?.snapshot ? h.snapshot() : null;
      return {
        agentId,
        running: !!s?.running,
        turns,
        pending: !!s?.pending,
        extra: s,
      };
    },
  };

  return harness;
}

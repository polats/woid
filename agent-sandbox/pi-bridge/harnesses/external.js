/**
 * ExternalHarness — the bridge runs no LLM of its own for this agent.
 * Instead, the agent's actions are driven by a remote HTTP client that:
 *   1. Obtains an `agentToken` from `POST /agents { harness: "external" }`.
 *   2. Subscribes to `GET /agents/:pubkey/events/stream?token=<agentToken>`.
 *   3. Waits for `turn_request` events and replies via
 *      `POST /agents/:pubkey/act` (Bearer auth).
 *   4. Heartbeats via `POST /agents/:pubkey/heartbeat` at least every
 *      HEARTBEAT_TIMEOUT_MS or gets evicted.
 *
 * The harness itself is passive — turn() awaits the client's /act.
 * server.js registers the SSE stream + the POST endpoints; those
 * routes reach back into the harness instance via a small API exposed
 * here (`attachStream`, `recordAct`, `touchHeartbeat`, `agentToken`).
 */

import crypto from "node:crypto";

const TURN_TIMEOUT_MS = Number(process.env.EXTERNAL_TURN_TIMEOUT_MS || 60_000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.EXTERNAL_HEARTBEAT_TIMEOUT_MS || 5 * 60_000);
const ACT_RATE_PER_MIN = Number(process.env.EXTERNAL_ACT_RATE_PER_MIN || 20);
const TOKEN_TTL_MS = Number(process.env.EXTERNAL_TOKEN_TTL_MS || 24 * 60 * 60_000);

export function createExternalHarness(deps = {}) {
  const secret = deps.secret ?? process.env.AGENT_TOKEN_SECRET ?? "";
  const now = deps.now ?? (() => Date.now());

  let agentId = null;
  let pubkey = null;
  let token = null;
  let systemPrompt = "";
  let provider = null;
  let model = null;
  let onEvent = () => {};
  let stopped = false;

  /** @type {{ res: any, lastId: number } | null} */
  let stream = null;
  /** @type {null | { turnId: string, resolve: Function, reject: Function, timer: any }} */
  let pending = null;
  let turnCounter = 0;
  let history = []; // rolling array of { role, content } pairs
  let lastHeartbeatAt = 0;
  /** @type {number[]} */
  let actTimestamps = [];

  function emitSse(eventName, data, id) {
    if (!stream) return false;
    try {
      const chunks = [];
      if (id !== undefined) chunks.push(`id: ${id}`);
      chunks.push(`event: ${eventName}`);
      chunks.push(`data: ${JSON.stringify(data)}`);
      stream.res.write(chunks.join("\n") + "\n\n");
      return true;
    } catch (err) {
      console.error(`[external:${agentId}] SSE write failed:`, err?.message || err);
      closeStream();
      return false;
    }
  }

  function closeStream() {
    if (!stream) return;
    try { stream.res.end(); } catch {}
    stream = null;
  }

  function failPending(err) {
    if (!pending) return;
    try { pending.reject(err instanceof Error ? err : new Error(String(err))); } catch {}
    if (pending.timer) clearTimeout(pending.timer);
    pending = null;
  }

  const harness = {
    name: "external",

    async start(opts) {
      if (!secret) {
        const err = new Error("AGENT_TOKEN_SECRET not configured; external harness disabled");
        err.code = 503;
        throw err;
      }
      agentId = opts.agentId;
      pubkey = opts.pubkey;
      systemPrompt = opts.systemPrompt;
      provider = opts.provider;
      model = opts.model;
      onEvent = opts.onEvent || (() => {});
      token = signToken({ agentId, pubkey, iat: now(), exp: now() + TOKEN_TTL_MS }, secret);
      lastHeartbeatAt = now();
      stopped = false;
    },

    updateSystemPrompt(next) {
      systemPrompt = next || "";
      // Notify the client so its context doesn't drift.
      emitSse("system_prompt", { systemPrompt });
    },

    async turn(userTurn) {
      if (stopped) throw new Error("external harness stopped");
      if (!agentId) throw new Error("external harness not started");

      turnCounter += 1;
      const turnId = `t${turnCounter}`;
      history.push({ role: "user", content: userTurn });
      if (history.length > 40) history = history.slice(-40);

      onEvent({ kind: "turn_start", data: { harness: "external", turn: turnCounter, turnId } });

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          failPending(new Error(`external turn ${turnId} timed out after ${TURN_TIMEOUT_MS}ms`));
          onEvent({ kind: "error", data: { where: "timeout", turnId } });
        }, TURN_TIMEOUT_MS);
        pending = { turnId, resolve, reject, timer };

        const delivered = emitSse(
          "turn_request",
          {
            turnId,
            deadline: now() + TURN_TIMEOUT_MS,
            context: {
              systemPrompt,
              provider,
              model,
              recentTurns: history.slice(-20),
              userTurn,
            },
          },
          turnCounter,
        );
        if (!delivered) {
          onEvent({ kind: "error", data: { where: "emit", message: "no stream connected" } });
          // We still wait — the client might reconnect before the timer fires.
        }
      });
    },

    async stop() {
      stopped = true;
      failPending(new Error("agent stopped"));
      emitSse("stopped", { reason: "stopped" });
      closeStream();
    },

    snapshot() {
      return {
        agentId,
        running: !stopped,
        turns: turnCounter,
        pending: !!pending,
        extra: {
          streamConnected: !!stream,
          lastHeartbeatAgeMs: lastHeartbeatAt ? now() - lastHeartbeatAt : null,
          history: history.length,
        },
      };
    },

    // ── external-harness-specific API used by server.js routes ──

    /** @returns {string|null} the bearer token issued at start(). */
    getToken() { return token; },

    /** @returns {string|null} pubkey (for route lookup). */
    getPubkey() { return pubkey; },

    /**
     * Verify a Bearer token against this harness's issued token.
     * Rejects stale / mismatched / expired payloads.
     */
    verifyToken(bearer) {
      if (!bearer) return null;
      const parsed = verifyToken(bearer, secret, now());
      if (!parsed) return null;
      if (parsed.agentId !== agentId || parsed.pubkey !== pubkey) return null;
      return parsed;
    },

    /**
     * Called by server.js when a GET /events/stream arrives. Takes over
     * the SSE response for this harness. Any previous stream is closed
     * (one driver at a time).
     */
    attachStream({ res, lastEventId }) {
      if (stream) closeStream();
      stream = { res, lastId: Number(lastEventId) || 0 };
      // Tell the client we're alive and, if a turn is pending, re-fire
      // the turn_request so reconnects don't miss their deadline.
      emitSse("room_joined", {
        agentId,
        pubkey,
        systemPrompt,
        provider,
        model,
      });
      if (pending) {
        emitSse(
          "turn_request",
          {
            turnId: pending.turnId,
            deadline: now() + TURN_TIMEOUT_MS,
            context: { recentTurns: history.slice(-20), userTurn: history[history.length - 1]?.content ?? "" },
            replayed: true,
          },
          turnCounter,
        );
      }
    },

    /** Called when the SSE client disconnects. */
    detachStream() { stream = null; },

    /**
     * Observed a room message — forward to the SSE client.
     * Called from the bridge's room subscription callback.
     */
    notifyMessage(msg) {
      emitSse("message", msg);
    },

    /**
     * Handle POST /act. Validates turn id + rate-limits, then resolves
     * the pending turn with the submitted actions.
     */
    recordAct({ turnId, text, move, state }) {
      if (!pending) {
        return { ok: false, code: 409, error: "no pending turn" };
      }
      if (pending.turnId !== turnId) {
        return { ok: false, code: 409, error: `stale turnId: pending=${pending.turnId}` };
      }
      // Rate limit window = last 60s.
      const t = now();
      actTimestamps = actTimestamps.filter((ts) => t - ts < 60_000);
      if (actTimestamps.length >= ACT_RATE_PER_MIN) {
        return { ok: false, code: 429, error: `rate limit: ${ACT_RATE_PER_MIN} posts/min` };
      }
      actTimestamps.push(t);

      const actions = [];
      if (typeof text === "string" && text.trim()) {
        actions.push({ type: "say", text: text.trim().slice(0, 1000) });
      }
      if (move && Number.isFinite(move.x) && Number.isFinite(move.y)) {
        actions.push({ type: "move", x: Math.round(move.x), y: Math.round(move.y) });
      }
      if (typeof state === "string" && state.trim()) {
        actions.push({ type: "state", value: state.trim().slice(0, 2000) });
      }

      // Record assistant turn in history for context continuity.
      history.push({ role: "assistant", content: JSON.stringify({ text, move, state }) });
      if (history.length > 40) history = history.slice(-40);

      for (const action of actions) onEvent({ kind: "action", data: action });
      onEvent({ kind: "turn_end", data: { harness: "external", turn: turnCounter } });

      const resolve = pending.resolve;
      if (pending.timer) clearTimeout(pending.timer);
      pending = null;

      resolve({ actions, thinking: undefined, usage: undefined });
      return { ok: true, actions };
    },

    touchHeartbeat() {
      lastHeartbeatAt = now();
    },

    /**
     * Check for heartbeat staleness. Returns true if this agent should
     * be evicted. Called periodically by the bridge's reaper.
     */
    isIdleTooLong() {
      if (stopped) return false;
      const age = now() - (lastHeartbeatAt || 0);
      return age > HEARTBEAT_TIMEOUT_MS;
    },
  };

  return harness;
}

// ── HMAC-signed token ──
// Payload-in-base64url + "." + sha256 hex signature.  Not a full JWT
// (no header/alg field) — simpler surface area, easier to audit, and
// since we never round-trip through a third party there's nothing to
// gain from JWS compatibility here.

export function signToken(payload, secret) {
  if (!secret) throw new Error("signToken requires a secret");
  const enc = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(enc).digest("hex");
  return `${enc}.${sig}`;
}

export function verifyToken(token, secret, nowMs = Date.now()) {
  if (!token || typeof token !== "string") return null;
  if (!secret) return null;
  const [enc, sig] = token.split(".");
  if (!enc || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(enc).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(enc, "base64url").toString()); } catch { return null; }
  if (typeof payload !== "object" || payload === null) return null;
  if (payload.exp && nowMs > payload.exp) return null;
  return payload;
}

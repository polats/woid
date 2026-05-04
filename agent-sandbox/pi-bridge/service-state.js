/**
 * Single-flight warmup + state cache for external services.
 *
 * The problem this fixes: each SSE flow used to run its own probe
 * loop against /v1/health/ready. With N concurrent generations
 * sharing one Cloud Run service (concurrency=1), that's N probe
 * loops that all waste time on the same cold start.
 *
 * The shape:
 *   - One Map keyed by service name.
 *   - First caller to find a service cold becomes the "leader" and
 *     starts a single warmup loop. The leader's promise is stored in
 *     the state.
 *   - All subsequent callers awaiting warmth await the same promise.
 *   - When the leader resolves, the state flips to WARM and a
 *     timestamp is recorded.
 *   - Within a TTL (60 s) of the last confirmed-warm probe, callers
 *     skip probing entirely and return immediately.
 *   - Heartbeat events from the leader's loop are broadcast to all
 *     awaiting callers via an EventTarget, so each caller's SSE
 *     stream still sees cold-start progress.
 */
import { EventEmitter } from "events";
import { urlOf, probeStrategyOf, SERVICES } from "./service-registry.js";

export const STATUS = Object.freeze({
  UNKNOWN: "unknown",   // never probed
  COLD:    "cold",      // probe failed and we're not warming
  WARMING: "warming",   // a warmup loop is in flight
  WARM:    "warm",      // recent probe succeeded
  FAILED:  "failed",    // gave up after coldBudgetMs
});

const WARM_CACHE_TTL_MS = 60_000;

// name -> {
//   status, lastProbe, lastWarm, warmingPromise, warmingStartedAt,
//   inFlight, totalWakes, lastError, emitter,
// }
const states = new Map();

function recordOf(name) {
  let r = states.get(name);
  if (!r) {
    r = {
      status: STATUS.UNKNOWN,
      lastProbe: null,
      lastWarm: null,                  // most recent successful probe
      warmingPromise: null,
      warmingStartedAt: null,          // start of CURRENT warming loop, if any
      lastColdStartedAt: null,         // start of MOST RECENT cold-start window
      lastBecameWarmAt: null,          // when state last transitioned cold→warm
      lastColdStartDurationMs: null,   // lastBecameWarmAt - lastColdStartedAt
      lastActivityAt: null,            // last begin/end of an in-flight call
      inFlight: 0,
      totalWakes: 0,
      lastError: null,
      emitter: new EventEmitter(),
    };
    r.emitter.setMaxListeners(50);
    states.set(name, r);
  }
  return r;
}

async function probeOnce(name, timeoutMs = 4000) {
  const url = urlOf(name);
  const strategy = probeStrategyOf(name);
  if (!url || !strategy) return false;
  const base = url.replace(/\/$/, "");
  try {
    const r = await fetch(`${base}${strategy.path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return strategy.isWarm(r);
  } catch {
    return false;
  }
}

/**
 * Ensure the named service is warm. Single-flight: concurrent callers
 * share one warmup loop. Calls `onHeartbeat` and `onStage` (if given)
 * during the warmup so SSE flows can stream the same progress events
 * to their clients.
 *
 * Resolves when the service is confirmed warm. Rejects with a
 * descriptive error if the cold-start budget is exhausted.
 */
export async function ensureWarm(name, opts = {}) {
  const { onHeartbeat, onStage } = opts;
  const cfg = SERVICES[name];
  if (!cfg) throw new Error(`unknown service '${name}'`);
  const url = urlOf(name);
  if (!url) throw new Error(`${cfg.urlEnv} not configured for service '${name}'`);

  const rec = recordOf(name);
  const now = Date.now();

  // (a) Recent warm — skip the probe entirely.
  if (rec.status === STATUS.WARM && rec.lastWarm && (now - rec.lastWarm) < WARM_CACHE_TTL_MS) {
    onStage?.({ stage: "warm", message: `${cfg.label} warm (cached)`, etaSeconds: cfg.warmEtaSeconds });
    return { fromCache: true, status: rec.status };
  }

  // (b) Warmup in flight — join the existing leader's promise. Pipe
  // the leader's heartbeats to this caller's SSE stream by subscribing
  // to the per-service emitter for the duration.
  if (rec.status === STATUS.WARMING && rec.warmingPromise) {
    const onHeartbeatLocal = (hb) => onHeartbeat?.(hb);
    const onStageLocal = (s) => onStage?.(s);
    rec.emitter.on("heartbeat", onHeartbeatLocal);
    rec.emitter.on("stage", onStageLocal);
    try {
      onStage?.({ stage: "joining-warmup", message: `joining ${cfg.label} warmup in progress`, etaSeconds: cfg.coldEtaSeconds });
      await rec.warmingPromise;
      return { fromCache: false, status: recordOf(name).status };
    } finally {
      rec.emitter.off("heartbeat", onHeartbeatLocal);
      rec.emitter.off("stage", onStageLocal);
    }
  }

  // (c) We're the leader. Quick probe first.
  rec.lastProbe = now;
  if (await probeOnce(name, 4000)) {
    const wasNotWarm = rec.status !== STATUS.WARM;
    rec.status = STATUS.WARM;
    rec.lastWarm = Date.now();
    if (wasNotWarm) rec.lastBecameWarmAt = rec.lastWarm;
    onStage?.({ stage: "warm", message: `${cfg.label} is warm`, etaSeconds: cfg.warmEtaSeconds });
    return { fromCache: false, status: rec.status };
  }

  // (d) Cold. Kick the warmup loop and broadcast the promise.
  onStage?.({
    stage: "cold-start",
    message: `${cfg.label} is cold — first request can take ~${Math.round(cfg.coldEtaSeconds / 60)} min`,
    etaSeconds: cfg.coldEtaSeconds,
  });
  rec.emitter.emit("stage", {
    stage: "cold-start",
    message: `${cfg.label} cold`,
    etaSeconds: cfg.coldEtaSeconds,
  });

  rec.status = STATUS.WARMING;
  rec.warmingStartedAt = Date.now();
  rec.lastColdStartedAt = rec.warmingStartedAt;  // separate ref so we can keep it after warm
  rec.totalWakes++;
  rec.warmingPromise = (async () => {
    const startedAt = rec.warmingStartedAt;
    while (true) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > cfg.coldBudgetMs) {
        rec.status = STATUS.FAILED;
        rec.lastError = `${name} did not become ready within ${Math.round(cfg.coldBudgetMs / 1000)}s`;
        rec.emitter.emit("failed", { error: rec.lastError });
        throw new Error(rec.lastError);
      }
      const hb = { elapsedMs: elapsed, phase: "cold-start" };
      onHeartbeat?.(hb);
      rec.emitter.emit("heartbeat", hb);
      await new Promise((r) => setTimeout(r, 5000));
      rec.lastProbe = Date.now();
      if (await probeOnce(name, 4000)) {
        rec.status = STATUS.WARM;
        rec.lastWarm = Date.now();
        rec.lastBecameWarmAt = rec.lastWarm;
        rec.lastColdStartDurationMs = rec.lastWarm - rec.lastColdStartedAt;
        rec.lastError = null;
        const stage = { stage: "warm", message: `${cfg.label} ready`, etaSeconds: cfg.warmEtaSeconds };
        onStage?.(stage);
        rec.emitter.emit("stage", stage);
        return;
      }
    }
  })().finally(() => {
    rec.warmingPromise = null;
    rec.warmingStartedAt = null;  // current-warm-loop done; lastColdStartedAt persists
  });

  await rec.warmingPromise;
  return { fromCache: false, status: rec.status };
}

/**
 * Per-service inference mutex. Cloud Run NIMs are deployed with
 * concurrency=1 — a second concurrent request hits 429 ("no available
 * instance") even when there's plenty of capacity, because the LB
 * won't let two requests share an instance. We serialize at the
 * bridge so Cloud Run only ever sees one inference call per service
 * in flight at a time, regardless of how many SSE clients are
 * waiting.
 *
 * Independent from `ensureWarm` (which already single-flights the
 * cold-start probe). `ensureWarm` synchronizes "is the service up
 * yet?"; this synchronizes "send the actual /v1/infer". Both are
 * needed: warm-up coordination doesn't help if N callers all fire
 * inference once warm.
 */
const serializerByService = new Map(); // name -> Promise<void> tail

/**
 * Serialize an async function against any other in-flight calls for
 * the same service. Returns whatever fn() returns. Heartbeat-style
 * progress emits during the wait (if onQueued/onAcquired are passed)
 * keep the SSE stream alive so clients see "queued" state.
 */
export async function withSerializedCall(name, fn, { onQueued, onAcquired } = {}) {
  const prior = serializerByService.get(name) || Promise.resolve();

  // Build the next link FIRST so subsequent callers chain off us, not
  // off `prior`, even before we've started running.
  let release;
  const next = new Promise((res) => { release = res; });
  // Chain the catch so a single rejected call doesn't poison every
  // subsequent caller with the same upstream error.
  serializerByService.set(name, prior.then(() => next, () => next));

  const queuedAt = Date.now();
  let waited = false;
  // Tell the caller they're queued ASAP, before awaiting, so the
  // first heartbeat reflects the real wait (which may be 0ms).
  // Calls that find the queue empty skip the "queued" event entirely.
  // We can't peek at the prior promise state in JS so we race:
  //   if it resolves immediately (no actual wait), skip onQueued.
  let queuedFired = false;
  const fireQueued = () => {
    if (queuedFired) return;
    queuedFired = true;
    waited = true;
    onQueued?.({ queuedAt });
  };
  const tick = setTimeout(fireQueued, 50);
  try {
    await prior;
  } finally {
    clearTimeout(tick);
  }
  onAcquired?.({ queuedAt, waitMs: waited ? Date.now() - queuedAt : 0 });

  try {
    return await fn();
  } finally {
    release();
  }
}

/** Caller is starting an inference call against this service. Bumps
 *  inFlight; pair every begin() with end(). Compat shim — prefer
 *  startCall() which carries character + prompt context. */
export function begin(name) {
  const rec = recordOf(name);
  rec.inFlight++;
  rec.lastActivityAt = Date.now();
  return () => {
    if (rec.inFlight > 0) rec.inFlight--;
    rec.lastActivityAt = Date.now();
  };
}

// Per-call tracking — gives the API-status pages a feed of
// "what is this service doing right now and on whose behalf".
// In-flight: Map<service, Map<callId, callMeta>>.
// Recent:    bounded LIFO; LIFO for cheap snapshotting.
const inFlightByService = new Map();
const recentCalls = [];
const RECENT_LIMIT = 200;

const PROMPT_SNIPPET_LEN = 240;

function snippet(s, n = PROMPT_SNIPPET_LEN) {
  if (typeof s !== "string") return null;
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/**
 * Begin tracking an inference call. Returns { callId, end }. End the
 * call by calling end({ ok, error, bytes }) — the call moves out of
 * the in-flight map into the recent ring buffer with duration.
 *
 * meta accepts:
 *   pubkey         — character npub or hex (string)
 *   characterName  — display label
 *   kind           — semantic tag: 'tpose' | 'mesh' | 'rig' | 'avatar' | 'wake' | …
 *   prompt         — the actual prompt sent upstream; we keep a
 *                    truncated `promptSnippet` and a sha256
 *                    `promptHash` for compact display + traceability.
 */
export function startCall(name, meta = {}) {
  const callId = "c_" + Math.random().toString(36).slice(2, 10);
  const startedAt = Date.now();
  const promptHash = meta.prompt
    ? "sha256:" + cryptoHash(meta.prompt).slice(0, 16)
    : null;
  const stored = {
    callId,
    service: name,
    startedAt,
    pubkey: meta.pubkey ?? null,
    characterName: meta.characterName ?? null,
    kind: meta.kind ?? null,
    promptSnippet: snippet(meta.prompt),
    promptHash,
    extra: meta.extra ?? null,
  };
  let m = inFlightByService.get(name);
  if (!m) { m = new Map(); inFlightByService.set(name, m); }
  m.set(callId, stored);
  const rec0 = recordOf(name);
  rec0.inFlight++;
  rec0.lastActivityAt = startedAt;
  return {
    callId,
    end({ ok = true, error = null, bytes = null } = {}) {
      const live = inFlightByService.get(name);
      if (live) live.delete(callId);
      const rec = recordOf(name);
      if (rec.inFlight > 0) rec.inFlight--;
      rec.lastActivityAt = Date.now();
      recentCalls.push({
        ...stored,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        ok,
        error: error ? String(error).slice(0, 400) : null,
        bytes: typeof bytes === "number" ? bytes : null,
      });
      if (recentCalls.length > RECENT_LIMIT) recentCalls.shift();
    },
  };
}

// Light-weight hash to avoid pulling in `crypto` everywhere — same
// rolling FNV-style sum as we use for hue derivation in the frontend.
// Good enough as an opaque identifier for "did two calls use the
// same prompt?" — not a security concern here.
function cryptoHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(2);
}

export function getInFlight({ service, pubkey } = {}) {
  const out = [];
  for (const [svc, m] of inFlightByService) {
    if (service && svc !== service) continue;
    for (const meta of m.values()) {
      if (pubkey && meta.pubkey !== pubkey) continue;
      out.push(meta);
    }
  }
  return out;
}

export function getRecentCalls({ service, pubkey, limit = 50 } = {}) {
  let arr = recentCalls;
  if (service) arr = arr.filter((c) => c.service === service);
  if (pubkey) arr = arr.filter((c) => c.pubkey === pubkey);
  return arr.slice(-limit).reverse();
}

/** Snapshot of a service's state for /v1/services/:name/status.
 *
 * Server-time fields (timestamps) are returned as ms-since-epoch so
 * the client can recompute "X ago" with sub-second resolution and
 * tick a live counter without polling. Computed fields (warmingForMs,
 * sleepInMs) are convenience snapshots — clients can recompute from
 * the timestamps but most readers want them ready.
 */
export function snapshot(name) {
  const cfg = SERVICES[name];
  if (!cfg) return null;
  const rec = recordOf(name);
  const url = urlOf(name);
  const now = Date.now();

  // How long the current warming loop has been running, if any.
  const warmingForMs = rec.warmingStartedAt && rec.status === STATUS.WARMING
    ? now - rec.warmingStartedAt
    : null;

  // Cloud Run scales to zero ~idleTimeoutMs after the last request.
  // Estimate "sleeps in" as that timeout minus elapsed-since-last-
  // activity. While inFlight > 0, the service is actively serving
  // and won't go idle.
  let sleepInMs = null;
  if (cfg.idleTimeoutMs && rec.status === STATUS.WARM) {
    if (rec.inFlight > 0) {
      sleepInMs = cfg.idleTimeoutMs;          // "in use" — clock keeps resetting
    } else {
      const lastTouch = rec.lastActivityAt || rec.lastWarm || rec.lastBecameWarmAt;
      const elapsed = lastTouch ? now - lastTouch : 0;
      sleepInMs = Math.max(0, cfg.idleTimeoutMs - elapsed);
    }
  }

  return {
    name,
    label: cfg.label,
    description: cfg.description,
    kind: cfg.kind,
    url: url || null,
    configured: !!url,
    status: rec.status,
    lastProbe: rec.lastProbe,
    lastWarm: rec.lastWarm,
    warmAgeMs: rec.lastWarm ? now - rec.lastWarm : null,

    // Cold-start lifecycle.
    warmingStartedAt: rec.warmingStartedAt,
    warmingForMs,
    lastColdStartedAt: rec.lastColdStartedAt,
    lastBecameWarmAt: rec.lastBecameWarmAt,
    lastColdStartDurationMs: rec.lastColdStartDurationMs,

    // Sleep / idle.
    idleTimeoutMs: cfg.idleTimeoutMs ?? null,
    lastActivityAt: rec.lastActivityAt,
    sleepInMs,

    inFlight: rec.inFlight,                           // count (back-compat)
    inFlightCalls: getInFlight({ service: name }),    // per-call detail
    recentCalls: getRecentCalls({ service: name, limit: 20 }),
    totalWakes: rec.totalWakes,
    lastError: rec.lastError,
    coldBudgetMs: cfg.coldBudgetMs,
    warmEtaSeconds: cfg.warmEtaSeconds,
    coldEtaSeconds: cfg.coldEtaSeconds,
  };
}

/** Snapshot of all services. */
export function snapshotAll() {
  const out = {};
  for (const name of Object.keys(SERVICES)) {
    out[name] = snapshot(name);
  }
  return out;
}

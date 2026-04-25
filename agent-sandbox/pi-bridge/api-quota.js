/**
 * Global token-bucket gate for persona/avatar generation.
 *
 * One bucket shared across all callers (public API + sandbox UI). Each
 * "generation" — text persona, avatar image, or a bundled text+image —
 * consumes exactly one slot. Both flavors hit NIM, so they share the
 * same budget.
 *
 * - PERSONA_API_PER_MIN slots refill linearly (default 30/min).
 * - No daily cap; the per-minute rate is the only ceiling.
 *
 * Separate from rate-limiter.js, which is a *reactive* per-provider
 * circuit breaker for upstream LLM 429s.
 */

const PER_MIN = Number(process.env.PERSONA_API_PER_MIN || 30);

const bucket = { tokens: PER_MIN, updatedAt: Date.now() };

// init() kept for compatibility with the call site; nothing to load now.
export function init(_workspace) { /* no-op */ }

function refill() {
  const now = Date.now();
  const elapsed = (now - bucket.updatedAt) / 60_000; // minutes
  bucket.tokens = Math.min(PER_MIN, bucket.tokens + elapsed * PER_MIN);
  bucket.updatedAt = now;
}

/**
 * Try to consume one slot. Returns `{ ok: true }` on success, or
 * `{ ok: false, status, error, retryAfterSec }` describing why we
 * refused. Caller is responsible for sending the response.
 */
export function tryConsume() {
  refill();
  if (bucket.tokens < 1) {
    const need = 1 - bucket.tokens;
    const retryAfterSec = Math.max(1, Math.ceil((need / PER_MIN) * 60));
    return {
      ok: false,
      status: 429,
      error: "rate limit exceeded",
      retryAfterSec,
      perMinute: PER_MIN,
    };
  }
  bucket.tokens -= 1;
  return { ok: true };
}

/** Express middleware wrapper around tryConsume. */
export function middleware(req, res, next) {
  const r = tryConsume();
  if (!r.ok) {
    res.set("Retry-After", String(r.retryAfterSec));
    return res.status(r.status).json({
      error: r.error,
      retryAfterSec: r.retryAfterSec,
      perMinute: r.perMinute,
    });
  }
  next();
}

/** No-op now (no daily cap). Kept so call sites don't need rewriting. */
export function recordSuccess() { /* no-op */ }

/** Refunds a slot to the bucket (e.g. on hard upstream failure). */
export function refund() {
  bucket.tokens = Math.min(PER_MIN, bucket.tokens + 1);
}

export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function snapshot() {
  refill();
  return {
    perMinute: PER_MIN,
    currentTokens: Math.floor(bucket.tokens),
  };
}

/**
 * Per-provider circuit breaker for LLM rate-limit / quota errors.
 *
 * - `recordError(provider, err)` classifies `err` as a 429 / quota /
 *   rate-limit style failure, and if so, puts `provider` into a
 *   cooldown window with exponential backoff. Returns true when it
 *   matched (caller treats the turn as gated rather than a hard error).
 * - `isInCooldown(provider)` — pass through before starting a turn;
 *   skip or defer if true.
 * - `snapshot()` — for /health introspection.
 *
 * Per-provider so a NIM throttle doesn't pause Gemini agents.
 */

const BACKOFF_MS = [10_000, 60_000, 300_000];
const cooldowns = new Map(); // provider -> { until, level, lastMessage }

function matchesRateLimit(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status === 429) return true;
  const msg = (err?.message ?? String(err)).toLowerCase();
  return /\b(429|rate.?limit|too many|quota|exceeded)\b/.test(msg);
}

export function recordError(provider, err) {
  if (!provider) return false;
  if (!matchesRateLimit(err)) return false;
  const cur = cooldowns.get(provider);
  const level = cur ? Math.min(cur.level + 1, BACKOFF_MS.length - 1) : 0;
  const until = Date.now() + BACKOFF_MS[level];
  cooldowns.set(provider, { until, level, lastMessage: err?.message ?? String(err) });
  console.warn(`[rate-limit] ${provider} -> cooldown level=${level} for ${BACKOFF_MS[level]/1000}s`);
  return true;
}

export function isInCooldown(provider) {
  const c = cooldowns.get(provider);
  if (!c) return false;
  if (Date.now() >= c.until) {
    cooldowns.delete(provider);
    console.log(`[rate-limit] ${provider} cooldown ended`);
    return false;
  }
  return true;
}

export function getCooldownRemaining(provider) {
  const c = cooldowns.get(provider);
  if (!c) return 0;
  return Math.max(0, c.until - Date.now());
}

export function snapshot() {
  const now = Date.now();
  const out = {};
  for (const [p, c] of cooldowns) {
    if (c.until > now) {
      out[p] = {
        remaining_ms: c.until - now,
        level: c.level,
        lastMessage: c.lastMessage,
      };
    }
  }
  return out;
}

export function reset() { cooldowns.clear(); }

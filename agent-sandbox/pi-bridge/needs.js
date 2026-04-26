/**
 * Needs vector — server-tracked per-character drives that decay
 * over sim-time. Three axes (`energy`, `social`, `curiosity`),
 * uniform decay rates across all characters. Personality lives in
 * the character bible (`about` field), not in a metabolic profile.
 *
 * Slice 1 of #235 ships the foundation: tracking, decay, derived
 * "wellbeing" level. Slice 2 will fire LLM-gate interrupts when an
 * axis crosses a threshold; slice 3 adds activity timetables; slice
 * 4 the daily event roll.
 *
 * Why these three (and not the Sims' five):
 *   energy     — drained ↔ wired. Universal across game shapes.
 *   social     — withdrawn ↔ eager. Drives talkativeness.
 *   curiosity  — bored ↔ absorbed. Drives "do something new."
 *
 * Hunger and hygiene are deliberately deferred. They earn their
 * place when smart objects (#245) provide affordances to satisfy
 * them; until then, "hunger 35" in a prompt is empty noise.
 *
 * Why "wellbeing" rather than emotion labels:
 *   The decay-driven scale measures BASELINE wellness — how is your
 *   inner weather right now. Emotions like anger / joy / fear are
 *   event-driven spikes that come from social or environmental
 *   triggers, not from your need vector. Mixing them confuses both
 *   the model and the player.
 *
 * Mapping to the manifest: legacy fields (`personality`,
 * `needs.hunger`, `needs.fun`, `needs.hygiene`) are ignored on read.
 */

export const NEED_AXES = ["energy", "social", "curiosity"];

export const DEFAULTS = {
  decayPerMin: {
    energy: 0.3,
    social: 0.5,
    curiosity: 0.4,
  },
  // Wall-clock to sim-time conversion. 1000ms = 1 sim-min by default
  // (so 30 real-sec ≈ 30 sim-min ≈ a noticeable need drop).
  simMinutePerRealMs: 1000,
  // Initial value for any axis on first registration.
  initialValue: 75,
  // Wellbeing bands. Worst-axis-value drives the level; ties broken by
  // ordering (higher band wins). Keep band names short and stable —
  // they appear in prompts, the inspector, and the map badge.
  wellbeingBands: [
    { name: "thriving",   min: 70 },
    { name: "uneasy",     min: 50 },
    { name: "distressed", min: 30 },
    { name: "in_crisis",  min: 0  },
  ],
};

/**
 * Create a new needs tracker. All cfg knobs are overridable for tests.
 */
export function createNeedsTracker(opts = {}) {
  const cleaned = Object.fromEntries(
    Object.entries(opts).filter(([, v]) => v !== undefined && v !== null),
  );
  const cfg = {
    decayPerMin: { ...DEFAULTS.decayPerMin, ...(cleaned.decayPerMin || {}) },
    simMinutePerRealMs: cleaned.simMinutePerRealMs ?? DEFAULTS.simMinutePerRealMs,
    initialValue: cleaned.initialValue ?? DEFAULTS.initialValue,
  };
  const now = opts.now ?? (() => Date.now());

  /** @type {Map<string, { needs: object, lastTickAt: number }>} */
  const chars = new Map();

  function register(pubkey, { needs } = {}) {
    if (!pubkey) return null;
    const existing = chars.get(pubkey);
    const next = {
      needs: blankNeeds(cfg.initialValue),
      lastTickAt: existing?.lastTickAt ?? now(),
    };
    if (existing?.needs) Object.assign(next.needs, existing.needs);
    if (needs && typeof needs === "object") {
      for (const axis of NEED_AXES) {
        const v = needs[axis];
        if (typeof v === "number" && Number.isFinite(v)) {
          next.needs[axis] = clamp(v);
        }
      }
    }
    chars.set(pubkey, next);
    return next;
  }

  function unregister(pubkey) {
    chars.delete(pubkey);
  }

  function get(pubkey) {
    return chars.get(pubkey) ?? null;
  }

  function tickAll(nowMs = now()) {
    const results = [];
    for (const [pubkey, rec] of chars) {
      const elapsedMs = Math.max(0, nowMs - rec.lastTickAt);
      if (elapsedMs <= 0) continue;
      const simMin = elapsedMs / cfg.simMinutePerRealMs;
      const before = { ...rec.needs };
      for (const axis of NEED_AXES) {
        const drop = (cfg.decayPerMin[axis] ?? 0) * simMin;
        rec.needs[axis] = clamp(rec.needs[axis] - drop);
      }
      rec.lastTickAt = nowMs;
      results.push({ pubkey, before, after: { ...rec.needs }, simMin });
    }
    return results;
  }

  function adjust(pubkey, axis, delta) {
    const rec = chars.get(pubkey);
    if (!rec || !NEED_AXES.includes(axis)) return null;
    rec.needs[axis] = clamp((rec.needs[axis] ?? cfg.initialValue) + delta);
    return rec.needs[axis];
  }

  function setAxis(pubkey, axis, value) {
    const rec = chars.get(pubkey);
    if (!rec || !NEED_AXES.includes(axis)) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    rec.needs[axis] = clamp(value);
    return rec.needs[axis];
  }

  function snapshot() {
    return [...chars.entries()].map(([pubkey, rec]) => ({
      pubkey,
      needs: { ...rec.needs },
      wellbeing: computeWellbeing(rec.needs),
      lastTickAt: rec.lastTickAt,
    }));
  }

  return {
    register, unregister, get,
    tickAll, adjust, setAxis,
    snapshot,
    _now: now,
    _cfg: cfg,
  };
}

// ── derived state ──

/**
 * Four-state wellbeing level from the needs vector. Computed
 * deterministically — the worst-axis value picks the band.
 */
export function computeWellbeing(needs) {
  const min = NEED_AXES.reduce((m, axis) => {
    const v = typeof needs?.[axis] === "number" ? needs[axis] : 100;
    return Math.min(m, v);
  }, 100);
  for (const band of DEFAULTS.wellbeingBands) {
    if (min >= band.min) return band.name;
  }
  return "in_crisis";
}

/**
 * Render a one-liner for the LLM perception block. Mentions the
 * wellbeing level and only the axes that are below 50.
 */
export function describeNeeds(needs) {
  if (!needs) return "";
  const wellbeing = computeWellbeing(needs);
  const pressing = NEED_AXES
    .map((axis) => ({ axis, v: Math.round(needs[axis] ?? 0) }))
    .filter((e) => e.v < 50)
    .sort((a, b) => a.v - b.v);
  if (pressing.length === 0) return `Wellbeing: ${wellbeing}.`;
  const list = pressing.map((e) => `${e.axis} ${e.v}`).join(", ");
  return `Wellbeing: ${wellbeing}. Pressing: ${list}.`;
}

// ── helpers ──

function blankNeeds(initial) {
  const out = {};
  for (const axis of NEED_AXES) out[axis] = initial;
  return out;
}

function clamp(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

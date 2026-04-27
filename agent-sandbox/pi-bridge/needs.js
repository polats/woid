/**
 * Needs vector — server-tracked per-character drives that decay
 * over sim-time. Two axes (`energy`, `social`) with uniform decay
 * rates. Identity lives in the character bible (`about` field), not
 * in a metabolic profile.
 *
 * Slice 1 of #275 narrows this to two axes — energy and social —
 * after #235's curiosity axis was deemed wrong for the audience
 * (cozy narrative sandbox, not a Sims-style needs sim). The
 * "what your mind is up to" surface lives in moodlets.js (event-
 * driven, not decay-driven). See docs/research/mood-systems.md and
 * docs/design/storyteller.md.
 *
 * Why these two:
 *   energy  — drained ↔ wired. Pulls the character toward rest.
 *   social  — withdrawn ↔ eager. Pulls the character toward people.
 *
 * Both have natural pull-toward-object semantics (bed for energy,
 * other characters for social) which makes them ideal scene-framers.
 * Mood / friction / drama is the moodlet system's job.
 *
 * Mapping to the manifest: legacy fields (`personality`, `needs.hunger`,
 * `needs.fun`, `needs.hygiene`, `needs.curiosity`) are ignored on
 * read; old `curiosity` values may still appear in legacy manifests
 * but the tracker silently drops them.
 */

export const NEED_AXES = ["energy", "social"];

/**
 * One-line per-axis description used in the system prompt. Drift
 * direction reads as "<low end> ↔ <high end>". Adding a new axis
 * means adding to this map + decayPerMin below — the system prompt
 * picks it up automatically.
 */
export const NEED_AXIS_DOCS = {
  energy: "drained ↔ wired",
  social: "withdrawn ↔ eager",
};

export const DEFAULTS = {
  // Decay rates calibrated against #275 slice 2's sim-clock cadence.
  // Energy drains 100→0 over 24 sim-hours (1 sim-day); social over
  // 48 sim-hours. Energy depletion is universal — everyone gets
  // tired by bedtime — while social is slower and more personality-
  // dependent (the traits system in docs/design/traits.md modulates
  // these per character).
  decayPerMin: {
    energy: 100 / (24 * 60),   // ≈ 0.0694 per sim-min
    social: 100 / (48 * 60),   // ≈ 0.0347 per sim-min
  },
  // Wall-clock to sim-time conversion. 1:1 by default — 1 real-min
  // is 1 sim-min, so 24 real-hours = 24 sim-hours = a full energy
  // drain. Override via NEEDS_SIM_MS_PER_MIN for dev (e.g. 2500 for
  // ~10 min real-time = 1 sim-day demos).
  simMinutePerRealMs: 60_000,
  // Initial value for any axis on first registration.
  initialValue: 75,
  // Threshold at which an axis is considered "low" — crossing from
  // above to below fires a one-shot perception event so the LLM is
  // notified ("you're feeling drained") on its next turn. Slice 2 of
  // #235's need-interrupt mechanism.
  lowThreshold: 30,
  // Wellbeing bands. Worst-axis-value drives the level; ties broken by
  // ordering (higher band wins). Keep band names short and stable —
  // they appear in prompts, the inspector, and the map badge.
  wellbeingBands: [
    // Thriving when the worst axis is still ≥ 50. Tuned more
    // forgiving than the Sims-shape default — characters spend
    // most of their time fine; only sustained inattention pushes
    // them into uneasy or below.
    { name: "thriving",   min: 50 },
    { name: "uneasy",     min: 30 },
    { name: "distressed", min: 15 },
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
    lowThreshold: cleaned.lowThreshold ?? DEFAULTS.lowThreshold,
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
      // Detect threshold crossings — axes that were >= lowThreshold
      // before this tick and < lowThreshold after. These produce
      // perception events the LLM sees on its next turn.
      const crossings = [];
      for (const axis of NEED_AXES) {
        if (before[axis] >= cfg.lowThreshold && rec.needs[axis] < cfg.lowThreshold) {
          crossings.push({ axis, from: before[axis], to: rec.needs[axis], level: "low" });
        }
      }
      results.push({ pubkey, before, after: { ...rec.needs }, simMin, crossings });
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

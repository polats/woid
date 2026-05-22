/**
 * Moodlets — event-driven affect, summed into a 4-band mood label.
 *
 * Browser-safe port of `agent-sandbox/pi-bridge/moodlets.js`. The
 * algorithm is byte-identical to the Node version; only the
 * persistence layer is abstracted. Pass `opts.persist` to wire any
 * storage backend (localStorage, IndexedDB, file system, network);
 * omit it for in-memory only.
 *
 * Convergence with the pi-bridge Node implementation is a deferred
 * hook in docs/design/agent-harness.md §7 ("Pi-bridge consumes
 * Brain interface"). Until then, the two implementations satisfy
 * the same API and behavior; only persistence wiring differs.
 *
 * See docs/research/mood-systems.md and docs/design/storyteller.md
 * §3.1 for design motivation; the schema below is canonical.
 *
 * Mood band derivation:
 *
 *   mood = clamp(50 + Σ active.weight, 0, 100)
 *   band:
 *     cheerful  (>= 70)
 *     steady    (>= 40)
 *     lousy     (>= 20)
 *     breaking  (<  20)
 */

export const MOOD_BANDS = [
  { name: "cheerful", min: 70 },
  { name: "steady",   min: 40 },
  { name: "lousy",    min: 20 },
  { name: "breaking", min: 0  },
];

export const DEFAULTS = {
  baseline: 50,
  defaultDurationMs: 12 * 60 * 60 * 1000, // 12h
};

/**
 * In-memory persistence stub. The default when no backend is provided.
 */
const memoryPersist = () => {
  const data = new Map();
  return {
    load: () => data,
    save: (key, bucket) => data.set(key, bucket.slice()),
  };
};

/**
 * @param {{
 *   persist?: {
 *     load:    () => Map<string, object[]>,
 *     save:    (key: string, bucket: object[]) => void,
 *   },
 *   now?: () => number,
 *   id?: () => string,
 *   baseline?: number,
 *   defaultDurationMs?: number,
 * }} opts
 */
export function createMoodletsTracker(opts = {}) {
  const persist = opts.persist ?? memoryPersist();
  const nowFn = opts.now ?? (() => Date.now());
  const idFn = opts.id ?? (() => `mdl_${randomId8()}`);
  const cfg = {
    baseline: opts.baseline ?? DEFAULTS.baseline,
    defaultDurationMs: opts.defaultDurationMs ?? DEFAULTS.defaultDurationMs,
  };

  /** @type {Map<string, object[]>} */
  const byKey = new Map();
  const loaded = persist.load();
  if (loaded && typeof loaded.forEach === "function") {
    loaded.forEach((bucket, key) => {
      if (Array.isArray(bucket) && bucket.length > 0) {
        byKey.set(key, bucket.slice());
      }
    });
  }

  function ensureBucket(key) {
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
    }
    return bucket;
  }

  function emit(key, input) {
    if (!key || typeof key !== "string") return null;
    if (!input || typeof input !== "object") return null;
    const tag = String(input.tag || "").trim();
    if (!tag) return null;
    const weight = Number.isFinite(input.weight) ? Math.trunc(input.weight) : 0;
    const now = nowFn();
    const moodlet = {
      id: idFn(),
      tag,
      weight,
      source: input.source ?? "card",
      reason: typeof input.reason === "string" ? input.reason : "",
      added_at: now,
      expires_at:
        input.expires_at === null ? null
        : Number.isFinite(input.expires_at) ? Math.trunc(input.expires_at)
        : Number.isFinite(input.duration_ms) ? now + Math.trunc(input.duration_ms)
        : now + cfg.defaultDurationMs,
    };
    if (input.by) moodlet.by = String(input.by);
    if (input.severity === 1 || input.severity === 2 || input.severity === 3) {
      moodlet.severity = input.severity;
    }
    if (typeof input.scene_id === "string") moodlet.scene_id = input.scene_id;
    if (typeof input.end_reason === "string") moodlet.end_reason = input.end_reason;
    ensureBucket(key).push(moodlet);
    persist.save(key, byKey.get(key));
    return moodlet;
  }

  function remove(key, moodletId) {
    const bucket = byKey.get(key);
    if (!bucket) return false;
    const idx = bucket.findIndex((m) => m.id === moodletId);
    if (idx < 0) return false;
    bucket.splice(idx, 1);
    persist.save(key, bucket);
    return true;
  }

  function clearByTag(key, pattern) {
    const bucket = byKey.get(key);
    if (!bucket) return 0;
    const match = makeMatcher(pattern);
    const before = bucket.length;
    const kept = bucket.filter((m) => !match(m.tag));
    const removed = before - kept.length;
    if (removed > 0) {
      byKey.set(key, kept);
      persist.save(key, kept);
    }
    return removed;
  }

  function listActive(key, nowMs) {
    const bucket = byKey.get(key);
    if (!bucket) return [];
    const t = nowMs ?? nowFn();
    return bucket.filter((m) => m.expires_at === null || m.expires_at > t);
  }

  function expireDue(nowMs) {
    const t = nowMs ?? nowFn();
    const out = [];
    for (const [key, bucket] of byKey) {
      const expired = [];
      const kept = [];
      for (const m of bucket) {
        if (m.expires_at !== null && m.expires_at <= t) expired.push(m);
        else kept.push(m);
      }
      if (expired.length > 0) {
        byKey.set(key, kept);
        persist.save(key, kept);
        out.push({ key, pubkey: key, expired });
      }
    }
    return out;
  }

  function aggregate(key, nowMs) {
    const active = listActive(key, nowMs);
    let sum = 0;
    for (const m of active) sum += m.weight;
    const mood = clamp(cfg.baseline + sum, 0, 100);
    const band = bandFor(mood);
    const breakdown = active.slice().sort((a, b) => b.weight - a.weight);
    return { mood, band, breakdown };
  }

  function snapshot(nowMs) {
    const t = nowMs ?? nowFn();
    const characters = [];
    let totalActive = 0;
    for (const key of byKey.keys()) {
      const active = listActive(key, t);
      totalActive += active.length;
      const { mood, band } = aggregate(key, t);
      characters.push({ key, pubkey: key, mood, band, activeCount: active.length });
    }
    return { totalActive, characters };
  }

  function unregister(key) {
    byKey.delete(key);
  }

  function clear(key) {
    if (key) {
      byKey.set(key, []);
      persist.save(key, []);
    } else {
      for (const k of byKey.keys()) {
        byKey.set(k, []);
        persist.save(k, []);
      }
    }
  }

  return {
    emit, remove, clearByTag,
    listActive, expireDue, aggregate, snapshot,
    unregister, clear,
    _now: nowFn,
    _cfg: cfg,
  };
}

// ── pure helpers ──────────────────────────────────────────────────

export function bandFor(mood) {
  for (const b of MOOD_BANDS) if (mood >= b.min) return b.name;
  return "breaking";
}

/**
 * One-line description for the LLM perception block. Reads:
 *   "Mood: lousy. Recently: Bob called her stupid (-8); slept poorly (-3)."
 */
export function describeMood(aggregateResult, opts = {}) {
  if (!aggregateResult) return "";
  const { band, breakdown } = aggregateResult;
  const limit = opts.limit ?? 4;
  if (!breakdown || breakdown.length === 0) return `Mood: ${band}.`;
  const parts = breakdown.slice(0, limit).map((m) => {
    const sign = m.weight >= 0 ? `+${m.weight}` : `${m.weight}`;
    const reason = m.reason ? m.reason : m.tag;
    return `${reason} (${sign})`;
  });
  return `Mood: ${band}. Recently: ${parts.join("; ")}.`;
}

/**
 * Build a localStorage-backed persistence adapter. Each character's
 * moodlets live under their own key for easy debugging and to avoid
 * rewriting unrelated buckets on each emit.
 *
 *   const persist = createLocalStoragePersist({ namespace: "woid.colony.moodlets.v1" })
 *   const tracker = createMoodletsTracker({ persist })
 */
export function createLocalStoragePersist({ namespace = "woid.moodlets.v1", storage } = {}) {
  const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!store) {
    // Fall back to in-memory if neither localStorage nor an explicit
    // store is available. Useful for SSR / tests.
    return memoryPersist();
  }
  const indexKey = `${namespace}.__index`;

  function load() {
    const all = new Map();
    let index;
    try {
      const raw = store.getItem(indexKey);
      index = raw ? JSON.parse(raw) : [];
    } catch {
      index = [];
    }
    if (!Array.isArray(index)) index = [];
    for (const key of index) {
      try {
        const raw = store.getItem(`${namespace}.${key}`);
        const bucket = raw ? JSON.parse(raw) : [];
        if (Array.isArray(bucket)) all.set(key, bucket);
      } catch {
        // skip malformed
      }
    }
    return all;
  }

  function save(key, bucket) {
    try {
      let index;
      try {
        const raw = store.getItem(indexKey);
        index = raw ? JSON.parse(raw) : [];
      } catch { index = []; }
      if (!Array.isArray(index)) index = [];
      if (!index.includes(key)) {
        index.push(key);
        store.setItem(indexKey, JSON.stringify(index));
      }
      store.setItem(`${namespace}.${key}`, JSON.stringify(bucket));
    } catch {
      // swallow quota / serialization errors silently — moodlets are
      // best-effort persistence
    }
  }

  return { load, save };
}

// ── helpers ───────────────────────────────────────────────────────

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function makeMatcher(pattern) {
  if (!pattern || pattern === "*") return () => true;
  const startsStar = pattern.startsWith("*");
  const endsStar = pattern.endsWith("*");
  if (startsStar && endsStar) {
    const mid = pattern.slice(1, -1);
    return (tag) => tag.includes(mid);
  }
  if (startsStar) {
    const tail = pattern.slice(1);
    return (tag) => tag.endsWith(tail);
  }
  if (endsStar) {
    const head = pattern.slice(0, -1);
    return (tag) => tag.startsWith(head);
  }
  return (tag) => tag === pattern;
}

function randomId8() {
  // Browser-safe randomness. Falls back to Math.random when crypto
  // is unavailable (older runtimes, JSDOM without webcrypto, etc).
  const cryptoLike = typeof globalThis !== "undefined" ? globalThis.crypto : null;
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID().replace(/-/g, "").slice(0, 8);
  if (cryptoLike?.getRandomValues) {
    const buf = new Uint8Array(4);
    cryptoLike.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

// ────────────────────────────────────────────────────────────────────────
// Demo seeds — curated set for `POST /moodlets/seed-demo` and similar.
// Audience-honest mix: ~70% warm/quirk, 25% mild friction, no permanent
// grudges, no cliffhangers. Originally from pi-bridge/moodlets.js.
// ────────────────────────────────────────────────────────────────────────

const DEMO_POOL = [
  // ── warmth / quirk (~70%) ─────────────────────────────────────────
  { tag: "discovered_morning_quiet", weight: 4, reason: "she likes how the apartment sounds before anyone is up", duration_ms: 12 * 3600_000 },
  { tag: "claimed_a_corner",         weight: 5, reason: "the window seat by the kettle is hers, by tacit agreement", expires_at: null },
  { tag: "slept_well",               weight: 3, reason: "a quiet, uninterrupted night", duration_ms: 8 * 3600_000 },
  { tag: "warm_kettle",              weight: 2, reason: "the tea was good this morning", duration_ms: 6 * 3600_000 },
  { tag: "small_routine",            weight: 3, reason: "settled into a rhythm she didn't have last week", expires_at: null },
  { tag: "made_something_useful",    weight: 4, reason: "fixed the cabinet without anyone noticing", duration_ms: 24 * 3600_000 },
  { tag: "shared_window_view",       weight: 3, reason: "watched the rain with someone, in companionable silence", duration_ms: 8 * 3600_000 },
  { tag: "kept_a_promise",           weight: 5, reason: "remembered to ask about the trip", duration_ms: 24 * 3600_000 },
  { tag: "small_compliment_received", weight: 4, reason: "someone said her sketches were getting bolder", duration_ms: 12 * 3600_000 },
  { tag: "wrote_something_decent",   weight: 4, reason: "one paragraph today, and it was good", duration_ms: 24 * 3600_000 },
  // ── mild friction (~25%) ──────────────────────────────────────────
  { tag: "kettle_disagreement",      weight: -2, reason: "they disagree about how strong the tea should be", duration_ms: 6 * 3600_000 },
  { tag: "music_too_loud",           weight: -2, reason: "the vinyl ran late last night", duration_ms: 4 * 3600_000 },
  { tag: "missed_a_chance_to_speak", weight: -3, reason: "wanted to say something at dinner; didn't", duration_ms: 24 * 3600_000 },
  { tag: "kitchen_is_cold",          weight: -2, reason: "the kitchen is cold, and someone disagrees about whether it is", duration_ms: 8 * 3600_000 },
];

/**
 * Emit a curated set of demo moodlets for each key. Idempotent by default —
 * keys with any active moodlets are skipped.
 *
 * @param {object} tracker    a tracker returned by createMoodletsTracker
 * @param {string[]} keys     pubkeys/character ids to seed
 * @param {object} [opts]
 * @param {number} [opts.minPerChar=2]
 * @param {number} [opts.maxPerChar=4]
 * @param {boolean} [opts.force=false]
 * @param {() => number} [opts.random]
 * @returns {{ pubkey: string, emitted: object[], skipped: boolean }[]}
 */
export function seedDemoMoodlets(tracker, keys, opts = {}) {
  const minPer = opts.minPerChar ?? 2;
  const maxPer = opts.maxPerChar ?? 4;
  const random = opts.random ?? Math.random;
  const out = [];
  for (const key of keys) {
    if (!opts.force && tracker.listActive(key).length > 0) {
      out.push({ pubkey: key, emitted: [], skipped: true });
      continue;
    }
    const count = minPer + Math.floor(random() * (maxPer - minPer + 1));
    const draws = _pickN(DEMO_POOL, count, random);
    const emitted = [];
    for (const draw of draws) {
      const m = tracker.emit(key, { ...draw, source: "user" });
      if (m) emitted.push(m);
    }
    out.push({ pubkey: key, emitted, skipped: false });
  }
  return out;
}

function _pickN(pool, n, random) {
  const copy = pool.slice();
  const out = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(random() * copy.length);
    out.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return out;
}

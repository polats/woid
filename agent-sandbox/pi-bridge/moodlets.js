/**
 * Moodlets — event-driven affect, summed into a 4-band mood label.
 *
 * Replaces the abandoned `curiosity` decay axis with the pattern
 * shared by RimWorld's Thoughts, CK3's Stress, Sims 4 Emotions, and
 * Project Zomboid's Moodles: small tagged events with weight and
 * duration, summed to derive a coarse mood band. See
 * docs/research/mood-systems.md and docs/design/storyteller.md §3.1
 * for the motivation; the schema below is the canonical implementation.
 *
 * A moodlet looks like:
 *
 *   {
 *     id:         ulid,
 *     tag:        "insulted_by:<pubkey>" | "slept_well" | …,
 *     weight:     signed integer, typical -10..+10,
 *     source:     "social" | "biology" | "environment" | "card" | "user",
 *     by?:        pubkey of the other character (for relationship aggregation),
 *     reason:     human prose for prompt + UI ("Bob called her stupid"),
 *     added_at:   sim/wall ms,
 *     expires_at: ms epoch | null (null = sticky until removed),
 *     severity?:  1 | 2 | 3 (PZ-style tiers; optional),
 *   }
 *
 * Persistence: one append-only JSONL file per pubkey under
 * `$WORKSPACE/moodlets/<pubkey>.jsonl`. We append on emit and
 * rewrite-in-place on remove/expire so the file doesn't grow
 * unbounded. (Compaction at session_close is part of #305.)
 *
 * Mood band derivation:
 *
 *   mood = clamp(50 + Σ active.weight, 0, 100)
 *   band:
 *     cheerful  (>= 70)  — net positive
 *     steady    (>= 40)  — baseline
 *     lousy     (>= 20)  — visibly off
 *     breaking  (<  20)  — crisis territory
 *
 * The band thresholds intentionally bias **warm** — most characters
 * sit at `steady` or above. See vertical-slice.md §3 for tonal
 * calibration: 70/25/5 charm/friction/drama.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const DIR_NAME = "moodlets";

export const MOOD_BANDS = [
  { name: "cheerful", min: 70 },
  { name: "steady",   min: 40 },
  { name: "lousy",    min: 20 },
  { name: "breaking", min: 0  },
];

export const DEFAULTS = {
  baseline: 50,
  // Default expiry for moodlets emitted without an explicit duration.
  // Most ambient moodlets are "fades by morning"; sticky ones must be
  // emitted with `expires_at: null`.
  defaultDurationMs: 12 * 60 * 60 * 1000, // 12h
};

/**
 * @param {{
 *   workspacePath: string,
 *   fs?: { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync },
 *   now?: () => number,
 *   id?: () => string,
 *   baseline?: number,
 *   defaultDurationMs?: number,
 * }} opts
 */
export function createMoodletsTracker(opts = {}) {
  if (!opts.workspacePath) throw new Error("createMoodletsTracker: workspacePath required");
  const fsImpl = opts.fs ?? { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync };
  const nowFn = opts.now ?? (() => Date.now());
  const idFn = opts.id ?? (() => `mdl_${randomUUID().slice(0, 8)}`);
  const cfg = {
    baseline: opts.baseline ?? DEFAULTS.baseline,
    defaultDurationMs: opts.defaultDurationMs ?? DEFAULTS.defaultDurationMs,
  };
  const dirPath = join(opts.workspacePath, DIR_NAME);

  /** @type {Map<string, object[]>} pubkey → moodlets */
  const byPubkey = new Map();

  loadFromDisk();

  function ensureBucket(pubkey) {
    let bucket = byPubkey.get(pubkey);
    if (!bucket) {
      bucket = [];
      byPubkey.set(pubkey, bucket);
    }
    return bucket;
  }

  function fileFor(pubkey) {
    return join(dirPath, `${pubkey}.jsonl`);
  }

  function emit(pubkey, input) {
    if (!pubkey || typeof pubkey !== "string") return null;
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
    // Provenance fields — when a moodlet is emitted from a scene close
    // (#275 slice 11) we want the scene_id + end_reason to round-trip
    // so the UI can deep-link from a moodlet to the scene that caused
    // it. Allowed but not required.
    if (typeof input.scene_id === "string") moodlet.scene_id = input.scene_id;
    if (typeof input.end_reason === "string") moodlet.end_reason = input.end_reason;
    ensureBucket(pubkey).push(moodlet);
    persist(pubkey);
    return moodlet;
  }

  function remove(pubkey, moodletId) {
    const bucket = byPubkey.get(pubkey);
    if (!bucket) return false;
    const idx = bucket.findIndex((m) => m.id === moodletId);
    if (idx < 0) return false;
    bucket.splice(idx, 1);
    persist(pubkey);
    return true;
  }

  /**
   * Remove every moodlet whose tag matches `pattern`.
   *   "exact"           — exact tag
   *   "prefix*"         — startsWith
   *   "*:by_<pubkey>"   — endsWith
   *   "insulted_by:*"   — startsWith
   *   "*"               — all
   * Returns the number of moodlets removed.
   */
  function clearByTag(pubkey, pattern) {
    const bucket = byPubkey.get(pubkey);
    if (!bucket) return 0;
    const match = makeMatcher(pattern);
    const before = bucket.length;
    const kept = bucket.filter((m) => !match(m.tag));
    const removed = before - kept.length;
    if (removed > 0) {
      byPubkey.set(pubkey, kept);
      persist(pubkey);
    }
    return removed;
  }

  function listActive(pubkey, nowMs) {
    const bucket = byPubkey.get(pubkey);
    if (!bucket) return [];
    const t = nowMs ?? nowFn();
    return bucket.filter((m) => m.expires_at === null || m.expires_at > t);
  }

  /**
   * Sweep across every tracked pubkey, removing expired moodlets.
   * Returns the per-pubkey list of expired records so callers can
   * emit perception events ("you no longer feel insulted by Bob").
   */
  function expireDue(nowMs) {
    const t = nowMs ?? nowFn();
    const out = [];
    for (const [pubkey, bucket] of byPubkey) {
      const expired = [];
      const kept = [];
      for (const m of bucket) {
        if (m.expires_at !== null && m.expires_at <= t) expired.push(m);
        else kept.push(m);
      }
      if (expired.length > 0) {
        byPubkey.set(pubkey, kept);
        persist(pubkey);
        out.push({ pubkey, expired });
      }
    }
    return out;
  }

  /**
   * { mood, band, breakdown:[{tag,weight,reason,expires_at,added_at}] }.
   * `breakdown` is sorted by weight descending so callers can render
   * the strongest moodlets first.
   */
  function aggregate(pubkey, nowMs) {
    const active = listActive(pubkey, nowMs);
    let sum = 0;
    for (const m of active) sum += m.weight;
    const mood = clamp(cfg.baseline + sum, 0, 100);
    const band = bandFor(mood);
    const breakdown = active
      .slice()
      .sort((a, b) => b.weight - a.weight);
    return { mood, band, breakdown };
  }

  function snapshot(nowMs) {
    const t = nowMs ?? nowFn();
    const characters = [];
    let totalActive = 0;
    for (const pubkey of byPubkey.keys()) {
      const active = listActive(pubkey, t);
      totalActive += active.length;
      const { mood, band } = aggregate(pubkey, t);
      characters.push({ pubkey, mood, band, activeCount: active.length });
    }
    return { totalActive, characters };
  }

  function unregister(pubkey) {
    byPubkey.delete(pubkey);
    // We deliberately keep the JSONL file on disk; if the character
    // returns we'd want their moodlet history back. Use clear() to
    // wipe.
  }

  function clear(pubkey) {
    if (pubkey) {
      byPubkey.set(pubkey, []);
      persist(pubkey);
    } else {
      for (const k of byPubkey.keys()) {
        byPubkey.set(k, []);
        persist(k);
      }
    }
  }

  // ── persistence ──

  function loadFromDisk() {
    if (!fsImpl.existsSync(dirPath)) return;
    let entries;
    try { entries = fsImpl.readdirSync(dirPath); }
    catch { return; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const pubkey = name.slice(0, -".jsonl".length);
      const filePath = join(dirPath, name);
      let text;
      try { text = fsImpl.readFileSync(filePath, "utf-8"); }
      catch { continue; }
      const bucket = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m?.id && m?.tag) bucket.push(m);
        } catch { /* skip malformed */ }
      }
      if (bucket.length > 0) byPubkey.set(pubkey, bucket);
    }
  }

  function persist(pubkey) {
    const bucket = byPubkey.get(pubkey) ?? [];
    const filePath = fileFor(pubkey);
    try {
      fsImpl.mkdirSync(dirname(filePath), { recursive: true });
      const lines = bucket.map((m) => JSON.stringify(m));
      fsImpl.writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""));
    } catch (err) {
      console.error(`[moodlets] persist ${filePath} failed:`, err?.message || err);
    }
  }

  return {
    emit, remove, clearByTag,
    listActive, expireDue, aggregate, snapshot,
    unregister, clear,
    _now: nowFn,
    _cfg: cfg,
    _dir: dirPath,
  };
}

// ── pure helpers (exported for direct use + tests) ──

export function bandFor(mood) {
  for (const b of MOOD_BANDS) if (mood >= b.min) return b.name;
  return "breaking";
}

/**
 * One-line description for the LLM perception block. Reads:
 *   "Mood: lousy. Recently: Bob called her stupid (-8); slept poorly (-3)."
 * If the character is at baseline with no active moodlets, returns
 * just "Mood: steady."
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

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Curated demo seeds — a small per-character mix of moodlets tuned to the
 * cozy/warm audience (70% positive, 25% mild friction, 5% sticky negative).
 * Used by `POST /moodlets/seed-demo` to populate a freshly-loaded workspace
 * so the Vitals UI shows something interesting on first visit.
 *
 * Each character gets a randomized draw from the pool — different characters
 * draw different moodlets so the household reads as varied. The pool stays
 * audience-honest: nothing grim, no permanent grudges, no cliffhangers.
 */
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
 * Emit a curated set of demo moodlets for each pubkey. Idempotent by
 * default — characters with any active moodlets are skipped.
 *
 * @param {object} tracker     a tracker returned by createMoodletsTracker
 * @param {string[]} pubkeys   character pubkeys to seed
 * @param {object} [opts]
 * @param {number} [opts.minPerChar=2]  fewest moodlets per character
 * @param {number} [opts.maxPerChar=4]  most moodlets per character
 * @param {boolean} [opts.force=false]  re-seed even if active moodlets exist
 * @param {() => number} [opts.random]  test seam
 * @returns {{ pubkey: string, emitted: object[], skipped: boolean }[]}
 */
export function seedDemoMoodlets(tracker, pubkeys, opts = {}) {
  const minPer = opts.minPerChar ?? 2;
  const maxPer = opts.maxPerChar ?? 4;
  const random = opts.random ?? Math.random;
  const out = [];
  for (const pubkey of pubkeys) {
    if (!opts.force && tracker.listActive(pubkey).length > 0) {
      out.push({ pubkey, emitted: [], skipped: true });
      continue;
    }
    const count = minPer + Math.floor(random() * (maxPer - minPer + 1));
    const draws = pickN(DEMO_POOL, count, random);
    const emitted = [];
    for (const draw of draws) {
      const m = tracker.emit(pubkey, { ...draw, source: "user" });
      if (m) emitted.push(m);
    }
    out.push({ pubkey, emitted, skipped: false });
  }
  return out;
}

function pickN(pool, n, random) {
  const copy = pool.slice();
  const out = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(random() * copy.length);
    out.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return out;
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

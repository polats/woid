/**
 * Moodlets tracker tests — emit, expire, aggregate, mood-band, persistence,
 * tag matching, describe rendering.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/moodlets.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMoodletsTracker,
  bandFor,
  describeMood,
  MOOD_BANDS,
  DEFAULTS,
} from "../moodlets.js";

function inMemoryFs() {
  const store = new Map();
  function existsSync(p) {
    if (store.has(p)) return true;
    // Treat a path as existing if any file lives beneath it.
    const prefix = p.endsWith("/") ? p : p + "/";
    for (const k of store.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }
  return {
    _store: store,
    mkdirSync: () => {},
    writeFileSync: (p, c) => store.set(p, String(c)),
    readFileSync: (p) => store.get(p) ?? "",
    existsSync,
    readdirSync: (p) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const out = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix) && k.endsWith(".jsonl")) {
          out.push(k.slice(prefix.length));
        }
      }
      return out;
    },
  };
}

function fakeClock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
    set: (ms) => { t = ms; return t; },
  };
}

let _id = 0;
function fakeId() { return `mdl_${++_id}`; }

// ── bands ──

test("MOOD_BANDS covers the four-state ladder", () => {
  assert.deepEqual(MOOD_BANDS.map((b) => b.name), ["cheerful", "steady", "lousy", "breaking"]);
});

test("bandFor: thresholds inclusive of min", () => {
  assert.equal(bandFor(100), "cheerful");
  assert.equal(bandFor(70), "cheerful");
  assert.equal(bandFor(69), "steady");
  assert.equal(bandFor(40), "steady");
  assert.equal(bandFor(39), "lousy");
  assert.equal(bandFor(20), "lousy");
  assert.equal(bandFor(19), "breaking");
  assert.equal(bandFor(0), "breaking");
});

// ── emit ──

test("emit: basic moodlet with default expiry", () => {
  _id = 0;
  const clock = fakeClock();
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), now: clock.now, id: fakeId });
  const m = t.emit("alice", { tag: "slept_well", weight: 3, reason: "rested fine" });
  assert.equal(m.tag, "slept_well");
  assert.equal(m.weight, 3);
  assert.equal(m.reason, "rested fine");
  assert.equal(m.added_at, clock.now());
  assert.equal(m.expires_at, clock.now() + DEFAULTS.defaultDurationMs);
  assert.equal(m.source, "card");
});

test("emit: explicit duration_ms takes precedence over default", () => {
  const clock = fakeClock();
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), now: clock.now, id: fakeId });
  const m = t.emit("alice", { tag: "x", weight: 1, duration_ms: 1000 });
  assert.equal(m.expires_at, clock.now() + 1000);
});

test("emit: explicit expires_at: null is sticky", () => {
  const clock = fakeClock();
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), now: clock.now, id: fakeId });
  const m = t.emit("alice", { tag: "claimed_corner", weight: 4, expires_at: null });
  assert.equal(m.expires_at, null);
});

test("emit: by field captured for relationship aggregation", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  const m = t.emit("alice", { tag: "insulted_by:bob", weight: -8, by: "bob", reason: "bob called her stupid" });
  assert.equal(m.by, "bob");
});

test("emit: rejects empty pubkey or empty tag", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  assert.equal(t.emit("", { tag: "x", weight: 1 }), null);
  assert.equal(t.emit(null, { tag: "x", weight: 1 }), null);
  assert.equal(t.emit("alice", { tag: "", weight: 1 }), null);
  assert.equal(t.emit("alice", null), null);
});

test("emit: severity tier 1..3 captured; out-of-range dropped", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  const ok = t.emit("alice", { tag: "x", weight: 1, severity: 2 });
  const bad = t.emit("alice", { tag: "y", weight: 1, severity: 7 });
  assert.equal(ok.severity, 2);
  assert.equal(bad.severity, undefined);
});

// ── listActive / expireDue ──

test("listActive: filters out expired entries", () => {
  const clock = fakeClock();
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), now: clock.now, id: fakeId });
  t.emit("alice", { tag: "short", weight: 1, duration_ms: 1000 });
  t.emit("alice", { tag: "long",  weight: 1, duration_ms: 1_000_000 });
  clock.advance(2000);
  const active = t.listActive("alice");
  assert.equal(active.length, 1);
  assert.equal(active[0].tag, "long");
});

test("listActive: sticky moodlet (expires_at null) never filtered out", () => {
  const clock = fakeClock();
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), now: clock.now, id: fakeId });
  t.emit("alice", { tag: "sticky", weight: 1, expires_at: null });
  clock.advance(10 * 365 * 24 * 60 * 60 * 1000); // 10 years
  assert.equal(t.listActive("alice").length, 1);
});

test("expireDue: removes expired and returns per-pubkey lists", () => {
  const clock = fakeClock();
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), now: clock.now, id: fakeId });
  t.emit("alice", { tag: "a", weight: 1, duration_ms: 1000 });
  t.emit("alice", { tag: "b", weight: 1, duration_ms: 100_000 });
  t.emit("bob",   { tag: "c", weight: 1, duration_ms: 1000 });
  clock.advance(2000);
  const out = t.expireDue();
  assert.equal(out.length, 2);
  const alice = out.find((r) => r.pubkey === "alice");
  const bob = out.find((r) => r.pubkey === "bob");
  assert.deepEqual(alice.expired.map((m) => m.tag), ["a"]);
  assert.deepEqual(bob.expired.map((m) => m.tag), ["c"]);
  assert.equal(t.listActive("alice").length, 1);
  assert.equal(t.listActive("bob").length, 0);
});

test("expireDue: empty when nothing has aged", () => {
  const clock = fakeClock();
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), now: clock.now, id: fakeId });
  t.emit("alice", { tag: "a", weight: 1, duration_ms: 100_000 });
  clock.advance(50);
  assert.deepEqual(t.expireDue(), []);
});

// ── aggregate / band ──

test("aggregate: empty bucket returns baseline mood", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  const a = t.aggregate("ghost");
  assert.equal(a.mood, DEFAULTS.baseline);
  assert.equal(a.band, "steady");
  assert.deepEqual(a.breakdown, []);
});

test("aggregate: positive moodlets push toward cheerful", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  t.emit("alice", { tag: "saw_friend", weight: 6, reason: "saw bob" });
  t.emit("alice", { tag: "slept_well", weight: 4, reason: "good sleep" });
  t.emit("alice", { tag: "warm_kettle", weight: 3, reason: "tea was good" });
  // Total +13 → 50 + 13 = 63 (steady, just under cheerful threshold of 70)
  const a = t.aggregate("alice");
  assert.equal(a.mood, 63);
  assert.equal(a.band, "steady");
  // breakdown sorted by weight desc
  assert.deepEqual(a.breakdown.map((m) => m.tag), ["saw_friend", "slept_well", "warm_kettle"]);
});

test("aggregate: negative moodlets drag toward breaking", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  t.emit("alice", { tag: "insulted_by:bob", weight: -20, reason: "bob was rude" });
  t.emit("alice", { tag: "slept_poorly", weight: -15, reason: "noisy night" });
  // 50 - 35 = 15 → breaking
  const a = t.aggregate("alice");
  assert.equal(a.mood, 15);
  assert.equal(a.band, "breaking");
});

test("aggregate: clamps at 0..100", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  t.emit("alice", { tag: "a", weight: 99, expires_at: null });
  t.emit("alice", { tag: "b", weight: 99, expires_at: null });
  assert.equal(t.aggregate("alice").mood, 100);
  t.clearByTag("alice", "*");
  t.emit("alice", { tag: "c", weight: -99, expires_at: null });
  t.emit("alice", { tag: "d", weight: -99, expires_at: null });
  assert.equal(t.aggregate("alice").mood, 0);
});

test("aggregate: ignores expired moodlets", () => {
  const clock = fakeClock();
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), now: clock.now, id: fakeId });
  t.emit("alice", { tag: "fades", weight: 30, duration_ms: 1000 });
  assert.equal(t.aggregate("alice").mood, 80);
  clock.advance(2000);
  assert.equal(t.aggregate("alice").mood, 50);
});

// ── clearByTag ──

test("clearByTag: exact match", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  t.emit("alice", { tag: "slept_well", weight: 3 });
  t.emit("alice", { tag: "slept_poorly", weight: -3 });
  assert.equal(t.clearByTag("alice", "slept_well"), 1);
  assert.equal(t.listActive("alice").length, 1);
});

test("clearByTag: prefix wildcard removes all matching", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  t.emit("alice", { tag: "insulted_by:bob", weight: -3 });
  t.emit("alice", { tag: "insulted_by:carl", weight: -3 });
  t.emit("alice", { tag: "saw_friend:bob", weight: +3 });
  assert.equal(t.clearByTag("alice", "insulted_by:*"), 2);
  assert.equal(t.listActive("alice").length, 1);
});

test("clearByTag: suffix wildcard via :by_<x> patterns", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  t.emit("alice", { tag: "saw_friend:bob", weight: 3, by: "bob" });
  t.emit("alice", { tag: "insulted_by:bob", weight: -3, by: "bob" });
  t.emit("alice", { tag: "saw_friend:carl", weight: 3, by: "carl" });
  assert.equal(t.clearByTag("alice", "*:bob"), 2);
});

test("clearByTag: '*' clears everything", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  t.emit("alice", { tag: "x", weight: 1 });
  t.emit("alice", { tag: "y", weight: 1 });
  assert.equal(t.clearByTag("alice", "*"), 2);
});

test("clearByTag: unknown pubkey returns 0", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  assert.equal(t.clearByTag("ghost", "x"), 0);
});

// ── persistence ──

test("persistence: emit then re-instantiate restores state", () => {
  const fs = inMemoryFs();
  const t1 = createMoodletsTracker({ workspacePath: "/ws", fs, id: fakeId });
  t1.emit("alice", { tag: "slept_well", weight: 3, reason: "good sleep", expires_at: null });
  t1.emit("alice", { tag: "saw_bob", weight: 2, reason: "saw bob", expires_at: null });

  const t2 = createMoodletsTracker({ workspacePath: "/ws", fs, id: fakeId });
  const active = t2.listActive("alice");
  assert.equal(active.length, 2);
  assert.equal(t2.aggregate("alice").mood, 55);
});

test("persistence: remove rewrites the file", () => {
  const fs = inMemoryFs();
  const t1 = createMoodletsTracker({ workspacePath: "/ws", fs, id: fakeId });
  const m = t1.emit("alice", { tag: "x", weight: 1, expires_at: null });
  t1.remove("alice", m.id);

  const t2 = createMoodletsTracker({ workspacePath: "/ws", fs, id: fakeId });
  assert.equal(t2.listActive("alice").length, 0);
});

// ── snapshot ──

test("snapshot: covers all tracked characters", () => {
  const t = createMoodletsTracker({ workspacePath: "/ws", fs: inMemoryFs(), id: fakeId });
  t.emit("alice", { tag: "x", weight: 5, expires_at: null });
  t.emit("bob",   { tag: "y", weight: -5, expires_at: null });
  const s = t.snapshot();
  assert.equal(s.totalActive, 2);
  assert.equal(s.characters.length, 2);
  const a = s.characters.find((c) => c.pubkey === "alice");
  const b = s.characters.find((c) => c.pubkey === "bob");
  assert.equal(a.mood, 55);
  assert.equal(b.mood, 45);
});

// ── describeMood ──

test("describeMood: empty active set reports band only", () => {
  assert.equal(describeMood({ band: "steady", breakdown: [] }), "Mood: steady.");
});

test("describeMood: lists strongest moodlets first with sign", () => {
  const out = describeMood({
    band: "lousy",
    breakdown: [
      { tag: "insulted_by:bob", weight: -8, reason: "bob called her stupid" },
      { tag: "slept_poorly",    weight: -3, reason: "noisy night" },
      { tag: "warm_kettle",     weight:  2, reason: "good tea" },
    ],
  });
  assert.match(out, /^Mood: lousy\./);
  assert.match(out, /bob called her stupid \(-8\)/);
  assert.match(out, /noisy night \(-3\)/);
  assert.match(out, /good tea \(\+2\)/);
});

test("describeMood: respects limit option", () => {
  // describeMood renders the breakdown as-is — aggregate() pre-sorts; tests
  // that bypass aggregate must pass already-sorted input.
  const breakdown = Array.from({ length: 10 }, (_, i) => ({
    tag: `t${i}`, weight: 10 - i, reason: `r${i}`,
  }));
  const out = describeMood({ band: "cheerful", breakdown }, { limit: 3 });
  // Should mention r0..r2 (the strongest); not r3.
  assert.match(out, /r0/);
  assert.match(out, /r2/);
  assert.ok(!/r3/.test(out));
});

test("describeMood: null/undefined returns empty string", () => {
  assert.equal(describeMood(null), "");
  assert.equal(describeMood(undefined), "");
});

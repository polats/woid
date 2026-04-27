/**
 * Schedule tests — slot derivation, timetable resolution, overrides,
 * persistence, "own" → owner-room resolution.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/schedule.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createScheduler, slotForHour, SLOTS, DEFAULT_TIMETABLE } from "../schedule.js";

function inMemoryFs() {
  const store = new Map();
  return {
    _store: store,
    mkdirSync: () => {},
    writeFileSync: (p, c) => store.set(p, String(c)),
    readFileSync: (p) => store.get(p) ?? "",
    existsSync: (p) => {
      if (store.has(p)) return true;
      const prefix = p.endsWith("/") ? p : p + "/";
      for (const k of store.keys()) if (k.startsWith(prefix)) return true;
      return false;
    },
    readdirSync: (p) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const out = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix) && k.endsWith(".json")) out.push(k.slice(prefix.length));
      }
      return out;
    },
  };
}

// ── slotForHour ──

test("slotForHour: maps standard windows", () => {
  assert.equal(slotForHour(8),  "morning");
  assert.equal(slotForHour(12), "midday");
  assert.equal(slotForHour(17), "afternoon");
  assert.equal(slotForHour(22), "evening");
  assert.equal(slotForHour(2),  "evening");  // wraps midnight
});

test("slotForHour: boundaries inclusive of start, exclusive of end", () => {
  assert.equal(slotForHour(6),  "morning");
  assert.equal(slotForHour(11), "midday");
  assert.equal(slotForHour(16), "afternoon");
  assert.equal(slotForHour(21), "evening");
  assert.equal(slotForHour(5),  "evening");
});

test("slotForHour: handles out-of-range hours by wrapping", () => {
  // 25 % 24 = 1; 1 < 6 → evening
  assert.equal(slotForHour(25), "evening");
  // -1 wraps to 23 → evening
  assert.equal(slotForHour(-1), "evening");
});

// ── timetableFor / defaults ──

test("timetableFor: returns full default timetable for an unseen character", () => {
  const s = createScheduler({ workspacePath: "/ws", fs: inMemoryFs() });
  const tt = s.timetableFor("alice");
  for (const slot of SLOTS) assert.equal(tt[slot], DEFAULT_TIMETABLE[slot]);
});

test("default timetable has overlap rooms (kitchen + hallway)", () => {
  // The whole point of this design: at least two slots resolve to
  // shared rooms so two characters with default schedules collide.
  const targets = SLOTS.map((s) => DEFAULT_TIMETABLE[s]);
  assert.ok(targets.includes("kitchen"));
  assert.ok(targets.includes("hallway"));
});

// ── targetRoomFor ──

test("targetRoomFor: literal rooms pass through", () => {
  const s = createScheduler({ workspacePath: "/ws", fs: inMemoryFs() });
  assert.equal(s.targetRoomFor("alice", "morning"),   "kitchen");
  assert.equal(s.targetRoomFor("alice", "afternoon"), "hallway");
});

test("targetRoomFor: 'own' resolves via the resolveOwnRoom callback", () => {
  const s = createScheduler({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    resolveOwnRoom: (pubkey) => `apt-of-${pubkey}`,
  });
  assert.equal(s.targetRoomFor("alice", "midday"),  "apt-of-alice");
  assert.equal(s.targetRoomFor("alice", "evening"), "apt-of-alice");
});

test("targetRoomFor: 'own' with no resolution returns null", () => {
  const s = createScheduler({ workspacePath: "/ws", fs: inMemoryFs() });
  assert.equal(s.targetRoomFor("ghost", "midday"), null);
});

test("targetRoomAtHour: drives the slot lookup from a sim-hour", () => {
  const s = createScheduler({
    workspacePath: "/ws", fs: inMemoryFs(),
    resolveOwnRoom: () => "apt-1A",
  });
  assert.equal(s.targetRoomAtHour("alice", 8),  "kitchen");
  assert.equal(s.targetRoomAtHour("alice", 12), "apt-1A");
  assert.equal(s.targetRoomAtHour("alice", 17), "hallway");
  assert.equal(s.targetRoomAtHour("alice", 23), "apt-1A");
});

// ── overrides ──

test("setSlot: overrides one slot but keeps defaults elsewhere", () => {
  const s = createScheduler({ workspacePath: "/ws", fs: inMemoryFs() });
  s.setSlot("alice", "morning", "apt-1B");
  const tt = s.timetableFor("alice");
  assert.equal(tt.morning, "apt-1B");
  assert.equal(tt.midday,  DEFAULT_TIMETABLE.midday);
});

test("setSlot: null clears the override; defaults return", () => {
  const s = createScheduler({ workspacePath: "/ws", fs: inMemoryFs() });
  s.setSlot("alice", "morning", "apt-1B");
  s.setSlot("alice", "morning", null);
  assert.equal(s.timetableFor("alice").morning, DEFAULT_TIMETABLE.morning);
});

test("setSlot: rejects unknown slot", () => {
  const s = createScheduler({ workspacePath: "/ws", fs: inMemoryFs() });
  assert.equal(s.setSlot("alice", "midnight", "kitchen"), null);
});

test("setTimetable: replaces the override map wholesale", () => {
  const s = createScheduler({ workspacePath: "/ws", fs: inMemoryFs() });
  s.setSlot("alice", "morning", "apt-1B");  // pre-existing override
  s.setTimetable("alice", { evening: "kitchen" });
  const tt = s.timetableFor("alice");
  assert.equal(tt.morning, DEFAULT_TIMETABLE.morning); // override cleared
  assert.equal(tt.evening, "kitchen");                  // new override
});

// ── persistence ──

test("persistence: setSlot survives re-instantiation", () => {
  const fs = inMemoryFs();
  const s1 = createScheduler({ workspacePath: "/ws", fs });
  s1.setSlot("alice", "morning", "apt-1B");
  s1.setSlot("alice", "evening", "kitchen");

  const s2 = createScheduler({ workspacePath: "/ws", fs });
  const tt = s2.timetableFor("alice");
  assert.equal(tt.morning, "apt-1B");
  assert.equal(tt.evening, "kitchen");
});

test("snapshot: lists override + effective per requested pubkey", () => {
  // snapshot() returns the *raw* timetable (with 'own' literals);
  // resolution to a concrete apartment happens at call time via
  // targetRoomFor / targetRoomAtHour. That keeps the snapshot
  // legible for editing.
  const s = createScheduler({ workspacePath: "/ws", fs: inMemoryFs() });
  s.setSlot("alice", "morning", "kitchen");
  const snap = s.snapshot(["alice", "bob"]);
  const a = snap.find((x) => x.pubkey === "alice");
  const b = snap.find((x) => x.pubkey === "bob");
  assert.equal(a.override.morning, "kitchen");
  assert.equal(a.effective.midday, "own"); // raw — resolves at use
  // Bob has no overrides — empty override map, defaults filled in.
  assert.deepEqual(b.override, {});
  assert.equal(b.effective.morning, DEFAULT_TIMETABLE.morning);
});

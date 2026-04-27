/**
 * Session store tests — open/close lifecycle, event append, sim-day
 * rollover detection, persistence.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/sessions.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionStore } from "../storyteller/sessions.js";

function inMemoryFs() {
  const store = new Map();
  return {
    _store: store,
    mkdirSync: () => {},
    writeFileSync: (p, c) => store.set(p, String(c)),
    readFileSync: (p) => store.get(p) ?? "",
    existsSync: (p) => store.has(p),
    appendFileSync: (p, c) => store.set(p, (store.get(p) ?? "") + String(c)),
  };
}

function fakeSimClock(initial = { sim_day: 0, sim_iso: "Day 0 · 06:00", real_ms: 1_000 }) {
  let snap = { ...initial };
  return {
    now: () => ({ ...snap }),
    simDay: () => snap.sim_day,
    advance: (delta) => {
      snap = { ...snap, ...delta, real_ms: (snap.real_ms ?? 0) + 1 };
      return snap;
    },
  };
}

let _id = 0;
const seqId = () => `ses_${++_id}`;

// ── ensureOpen ──

test("ensureOpen: creates a session for current sim-day on first call", async () => {
  const store = createSessionStore({
    workspacePath: "/ws", fs: inMemoryFs(),
    simClock: fakeSimClock(), id: seqId,
  });
  const s = await store.ensureOpen();
  assert.equal(s.sim_day, 0);
  assert.equal(s.events.length, 0);
  assert.equal(s.closed_at, null);
});

test("ensureOpen: idempotent within the same sim-day", async () => {
  const store = createSessionStore({
    workspacePath: "/ws", fs: inMemoryFs(),
    simClock: fakeSimClock(), id: seqId,
  });
  const s1 = await store.ensureOpen();
  const s2 = await store.ensureOpen();
  assert.equal(s1.id, s2.id);
});

test("ensureOpen: closes stale session and opens a new one when sim-day rolls over", async () => {
  const fs = inMemoryFs();
  const clock = fakeSimClock();
  const closed = [];
  const store = createSessionStore({
    workspacePath: "/ws", fs, id: seqId,
    simClock: clock,
    onClose: (rec) => { closed.push({ id: rec.id, sim_day: rec.sim_day }); },
  });
  const day0 = await store.ensureOpen();
  clock.advance({ sim_day: 1, sim_iso: "Day 1 · 06:00" });
  const day1 = await store.ensureOpen();
  assert.notEqual(day0.id, day1.id);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, day0.id);
  assert.equal(closed[0].sim_day, 0);
});

// ── appendEvent ──

test("appendEvent: stamps ts and appends to the current session", async () => {
  const store = createSessionStore({
    workspacePath: "/ws", fs: inMemoryFs(),
    simClock: fakeSimClock(), id: seqId,
  });
  await store.ensureOpen();
  store.appendEvent({ kind: "scene_close", scene_id: "s1" });
  store.appendEvent({ kind: "moodlet", tag: "x", weight: 6 });
  const cur = store.current();
  assert.equal(cur.events.length, 2);
  for (const e of cur.events) assert.ok(typeof e.ts === "number");
});

test("appendEvent: drops events without a kind", async () => {
  const store = createSessionStore({
    workspacePath: "/ws", fs: inMemoryFs(),
    simClock: fakeSimClock(), id: seqId,
  });
  await store.ensureOpen();
  store.appendEvent({ scene_id: "s1" });
  store.appendEvent(null);
  store.appendEvent({});
  assert.equal(store.current().events.length, 0);
});

// ── close + persistence ──

test("closeCurrent: finalizes record and runs onClose hook", async () => {
  const got = [];
  const store = createSessionStore({
    workspacePath: "/ws", fs: inMemoryFs(),
    simClock: fakeSimClock(), id: seqId,
    onClose: (rec) => { got.push(rec); rec.recap = "test recap"; },
  });
  const s = await store.ensureOpen();
  store.appendEvent({ kind: "x" });
  const closed = await store.closeCurrent({ reason: "test" });
  assert.equal(closed.id, s.id);
  assert.equal(closed.end_reason, "test");
  assert.equal(closed.events.length, 1);
  assert.equal(closed.recap, "test recap");
  assert.equal(got.length, 1);
});

test("closeCurrent: persists to JSONL; listClosed reads it back", async () => {
  const fs = inMemoryFs();
  const clock = fakeSimClock();
  const store = createSessionStore({
    workspacePath: "/ws", fs, id: seqId, simClock: clock,
  });
  await store.ensureOpen();
  store.appendEvent({ kind: "scene_close", scene_id: "s1" });
  await store.closeCurrent();

  clock.advance({ sim_day: 1 });
  await store.ensureOpen();
  store.appendEvent({ kind: "moodlet", weight: 6 });
  await store.closeCurrent();

  const list = store.listClosed();
  assert.equal(list.length, 2);
  // Newest first.
  assert.equal(list[0].sim_day, 1);
  assert.equal(list[1].sim_day, 0);
});

// ── lookup ──

test("getById / getBySimDay return open + closed records", async () => {
  const fs = inMemoryFs();
  const clock = fakeSimClock();
  const store = createSessionStore({
    workspacePath: "/ws", fs, id: seqId, simClock: clock,
  });
  const s0 = await store.ensureOpen();
  await store.closeCurrent();
  clock.advance({ sim_day: 1 });
  const s1 = await store.ensureOpen();

  assert.equal(store.getById(s0.id).sim_day, 0);
  assert.equal(store.getById(s1.id).sim_day, 1);
  assert.equal(store.getBySimDay(0).id, s0.id);
  assert.equal(store.getBySimDay(1).id, s1.id);
  assert.equal(store.getBySimDay(99), null);
});

// ── persistence: open session survives bridge restart ──

test("loadCurrent: on re-instantiation, in-progress session is restored", async () => {
  const fs = inMemoryFs();
  const clock = fakeSimClock();
  const s1 = createSessionStore({
    workspacePath: "/ws", fs, id: seqId, simClock: clock,
  });
  await s1.ensureOpen();
  s1.appendEvent({ kind: "scene_close", scene_id: "s1" });

  // "Restart" — same fs, new store instance.
  const s2 = createSessionStore({
    workspacePath: "/ws", fs, id: seqId, simClock: clock,
  });
  const cur = s2.current();
  assert.ok(cur, "current session should be restored");
  assert.equal(cur.events.length, 1);
  assert.equal(cur.events[0].kind, "scene_close");
});

// ── snapshot ──

test("snapshot: reports open session + closed count", async () => {
  const fs = inMemoryFs();
  const clock = fakeSimClock();
  const store = createSessionStore({
    workspacePath: "/ws", fs, id: seqId, simClock: clock,
  });
  await store.ensureOpen();
  await store.closeCurrent();
  clock.advance({ sim_day: 1 });
  await store.ensureOpen();
  const snap = store.snapshot();
  assert.equal(snap.current.sim_day, 1);
  assert.equal(snap.closed_count, 1);
});

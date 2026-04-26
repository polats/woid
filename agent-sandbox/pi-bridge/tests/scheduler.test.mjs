/**
 * Scheduler tests. Stubbed timers + snapshot so we can synchronously
 * drive ticks.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/scheduler.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createScheduler, DEFAULTS } from "../scheduler.js";

function makeFakeTimers() {
  const queue = []; // { id, fn, due }
  let id = 0;
  let nowMs = 0;
  function setTimeoutFn(fn, ms) {
    const due = nowMs + ms;
    const entry = { id: ++id, fn, due };
    queue.push(entry);
    return entry;
  }
  function clearTimeoutFn(handle) {
    const i = queue.indexOf(handle);
    if (i >= 0) queue.splice(i, 1);
  }
  async function advance(ms) {
    const target = nowMs + ms;
    // Fire timers in order, advancing virtual time to each one's due
    // *before* its fn runs so any reschedules inside use the right
    // baseline. Without this, a tick at t=5s scheduling another for
    // "now+5s" would resolve to (15s+5s) = 20s instead of 10s.
    while (queue.length > 0) {
      const sorted = [...queue].sort((a, b) => a.due - b.due);
      const next = sorted[0];
      if (next.due > target) break;
      nowMs = next.due;
      const i = queue.indexOf(next);
      queue.splice(i, 1);
      await next.fn();
    }
    nowMs = target;
  }
  return { setTimeoutFn, clearTimeoutFn, advance, queue, now: () => nowMs };
}

const TWO_AGENT_NEAR = {
  agents: [
    { npub: "a", name: "A", x: 5, y: 5 },
    { npub: "b", name: "B", x: 6, y: 5 }, // distance 1, in scene
  ],
};
const TWO_AGENT_FAR = {
  agents: [
    { npub: "a", name: "A", x: 5, y: 5 },
    { npub: "b", name: "B", x: 15, y: 15 }, // way out of scene
  ],
};

function makeRec(npub) {
  return { agentId: `ag_${npub}`, pubkey: npub, listening: true, thinking: false };
}

// ── factory ──

test("createScheduler throws without required deps", () => {
  assert.throws(() => createScheduler({}));
  assert.throws(() => createScheduler({ getSnapshot: () => ({}) }));
});

// ── cadence ──

test("cadence: in-scene picks from short range", () => {
  const sch = createScheduler(
    { getSnapshot: () => TWO_AGENT_NEAR, runTurn: async () => {}, random: () => 0 },
  );
  const ms = sch._nextCadenceMs(makeRec("a"));
  assert.equal(ms, DEFAULTS.sceneMinMs);
});

test("cadence: alone picks from long range", () => {
  const sch = createScheduler(
    { getSnapshot: () => TWO_AGENT_FAR, runTurn: async () => {}, random: () => 0 },
  );
  const ms = sch._nextCadenceMs(makeRec("a"));
  assert.equal(ms, DEFAULTS.aloneMinMs);
});

test("cadence: random()=1 picks the upper bound", () => {
  const sch = createScheduler(
    { getSnapshot: () => TWO_AGENT_NEAR, runTurn: async () => {}, random: () => 1 },
  );
  const ms = sch._nextCadenceMs(makeRec("a"));
  assert.equal(ms, DEFAULTS.sceneMaxMs);
});

// ── attach / detach / tick ──

test("attach schedules a heartbeat turn after cadence", async () => {
  const fake = makeFakeTimers();
  const turns = [];
  const sch = createScheduler({
    getSnapshot: () => TWO_AGENT_FAR,
    runTurn: async (rec, opts) => turns.push({ id: rec.agentId, ...opts }),
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    random: () => 0, // deterministic — uses lo bound (30s alone)
  });
  const rec = makeRec("a");
  sch.attach(rec);
  // Right at boundary — should fire.
  await fake.advance(DEFAULTS.aloneMinMs);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].trigger, "heartbeat");
  assert.equal(turns[0].id, "ag_a");
});

test("attach reschedules after each tick", async () => {
  const fake = makeFakeTimers();
  let count = 0;
  const sch = createScheduler({
    getSnapshot: () => TWO_AGENT_NEAR,
    runTurn: async () => { count++; },
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    random: () => 0, // 5s in-scene
  });
  const rec = makeRec("a");
  sch.attach(rec);
  await fake.advance(15_000);
  // 5s, 10s, 15s — three ticks.
  assert.equal(count, 3);
});

test("tick does not run when rec.thinking is true", async () => {
  const fake = makeFakeTimers();
  let runs = 0;
  const sch = createScheduler({
    getSnapshot: () => TWO_AGENT_NEAR,
    runTurn: async () => { runs++; },
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    random: () => 0,
  });
  const rec = makeRec("a");
  rec.thinking = true;
  sch.attach(rec);
  await fake.advance(20_000);
  assert.equal(runs, 0);
  // Once thinking flips off, the next tick runs.
  rec.thinking = false;
  await fake.advance(10_000);
  assert.ok(runs >= 1);
});

test("detach cancels future ticks", async () => {
  const fake = makeFakeTimers();
  let runs = 0;
  const sch = createScheduler({
    getSnapshot: () => TWO_AGENT_NEAR,
    runTurn: async () => { runs++; },
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    random: () => 0,
  });
  const rec = makeRec("a");
  sch.attach(rec);
  sch.detach(rec);
  await fake.advance(60_000);
  assert.equal(runs, 0);
});

test("listening=false stops the loop after current tick", async () => {
  const fake = makeFakeTimers();
  let runs = 0;
  const sch = createScheduler({
    getSnapshot: () => TWO_AGENT_NEAR,
    runTurn: async () => { runs++; },
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    random: () => 0,
  });
  const rec = makeRec("a");
  sch.attach(rec);
  await fake.advance(5_000); // 1 tick
  rec.listening = false;
  await fake.advance(60_000);
  assert.equal(runs, 1);
});

test("multiple agents are scheduled independently", async () => {
  const fake = makeFakeTimers();
  const calls = [];
  const sch = createScheduler({
    getSnapshot: () => TWO_AGENT_NEAR,
    runTurn: async (rec) => { calls.push(rec.agentId); },
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    random: () => 0,
  });
  const a = makeRec("a");
  const b = makeRec("b");
  sch.attach(a);
  sch.attach(b);
  await fake.advance(10_000);
  // 5s, 10s for each — 4 calls total.
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((c) => c === "ag_a").length, 2);
  assert.equal(calls.filter((c) => c === "ag_b").length, 2);
});

test("activeAgentIds reports currently scheduled agents", () => {
  const fake = makeFakeTimers();
  const sch = createScheduler({
    getSnapshot: () => TWO_AGENT_NEAR,
    runTurn: async () => {},
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    random: () => 0,
  });
  const a = makeRec("a");
  sch.attach(a);
  assert.deepEqual(sch.activeAgentIds(), ["ag_a"]);
  sch.detach(a);
  assert.deepEqual(sch.activeAgentIds(), []);
});

test("cadence at next reschedule reflects current scene", async () => {
  // Cadence is sampled at schedule time, not fire time — so a scene
  // change between ticks affects only the *next* tick's interval, not
  // the one already pending. That's intentional: reactive triggers
  // (arrival, message_received) handle fast response; the heartbeat
  // is a backstop for "nothing's happening."
  const fake = makeFakeTimers();
  let snapshot = TWO_AGENT_FAR;
  let runs = 0;
  const sch = createScheduler({
    getSnapshot: () => snapshot,
    runTurn: async () => { runs++; },
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    random: () => 0,
  });
  const rec = makeRec("a");
  sch.attach(rec);
  // First tick at 30s while alone. After it fires, snapshot is still
  // alone, so next tick is also alone-cadence (30s).
  await fake.advance(30_000);
  assert.equal(runs, 1);
  // Now move into scene before the second tick fires.
  snapshot = TWO_AGENT_NEAR;
  // The pending timer was scheduled with alone-cadence (60s mark).
  // Advancing 5s won't fire it.
  await fake.advance(5_000);
  assert.equal(runs, 1);
  // After the alone-cadence elapses, the in-scene snapshot is read,
  // so the *next* reschedule uses scene-cadence (5s).
  await fake.advance(25_000); // total alone tick at 60s
  assert.equal(runs, 2);
  await fake.advance(5_000); // scene tick at 65s
  assert.equal(runs, 3);
});

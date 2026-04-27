/**
 * Perception event ring buffer tests.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/perception.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createPerception, formatPerceptionEvents } from "../perception.js";

// ── append / drain ──

test("appendOne stores an event with stamped ts", () => {
  let t = 1000;
  const p = createPerception({ now: () => t });
  p.appendOne("alice", { kind: "speech", from_name: "Bob", text: "hi" });
  const evs = p.snapshot("alice");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "speech");
  assert.equal(evs[0].ts, 1000);
});

test("appendOne respects an explicit ts", () => {
  const p = createPerception({ now: () => 9999 });
  p.appendOne("alice", { kind: "speech", ts: 42, text: "hello" });
  assert.equal(p.snapshot("alice")[0].ts, 42);
});

test("appendOne ignores events with no kind", () => {
  const p = createPerception();
  p.appendOne("alice", { text: "no kind" });
  p.appendOne("alice", { kind: "" });
  p.appendOne("alice", null);
  assert.equal(p.snapshot("alice").length, 0);
});

test("appendOne is a no-op for missing pubkey", () => {
  const p = createPerception();
  p.appendOne(null, { kind: "speech" });
  p.appendOne("", { kind: "speech" });
  // No throw, no buffer created.
  assert.deepEqual(p.snapshot("anyone"), []);
});

test("buffer ring-evicts oldest when over size", () => {
  const p = createPerception({ bufferSize: 3, now: () => 1 });
  for (let i = 0; i < 5; i++) p.appendOne("alice", { kind: "speech", seq: i });
  const evs = p.snapshot("alice");
  assert.equal(evs.length, 3);
  assert.deepEqual(evs.map((e) => e.seq), [2, 3, 4]);
});

// ── broadcastTo ──

test("broadcastTo writes to each target except exceptPubkey", () => {
  const p = createPerception({ now: () => 100 });
  p.broadcastTo(["alice", "bob", "carol"], { kind: "movement", who_name: "Dave", x: 1, y: 2 }, "carol");
  assert.equal(p.snapshot("alice").length, 1);
  assert.equal(p.snapshot("bob").length, 1);
  assert.equal(p.snapshot("carol").length, 0);
});

test("broadcastTo: empty targets is a no-op", () => {
  const p = createPerception();
  p.broadcastTo([], { kind: "movement" });
  p.broadcastTo(null, { kind: "movement" });
  assert.deepEqual(p.snapshot("anyone"), []);
});

test("broadcastTo: single ts shared across recipients", () => {
  let t = 500;
  const p = createPerception({ now: () => t });
  p.broadcastTo(["a", "b"], { kind: "speech", text: "x" });
  assert.equal(p.snapshot("a")[0].ts, p.snapshot("b")[0].ts);
});

// ── eventsSince ──

test("eventsSince returns only newer events", () => {
  let t = 0;
  const p = createPerception({ now: () => ++t });
  p.appendOne("alice", { kind: "speech", text: "1" });
  p.appendOne("alice", { kind: "speech", text: "2" });
  p.appendOne("alice", { kind: "speech", text: "3" });
  const lastSeen = p.snapshot("alice")[1].ts;
  const fresh = p.eventsSince("alice", lastSeen);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].text, "3");
});

test("eventsSince returns all when sinceTs is undefined", () => {
  const p = createPerception();
  p.appendOne("alice", { kind: "speech", text: "1" });
  p.appendOne("alice", { kind: "speech", text: "2" });
  assert.equal(p.eventsSince("alice").length, 2);
});

test("eventsSince does not mutate the buffer", () => {
  const p = createPerception();
  p.appendOne("alice", { kind: "speech" });
  p.eventsSince("alice", 0);
  assert.equal(p.snapshot("alice").length, 1);
});

// ── clear / clearAll ──

test("clear drops one buffer", () => {
  const p = createPerception();
  p.appendOne("alice", { kind: "speech" });
  p.appendOne("bob", { kind: "speech" });
  p.clear("alice");
  assert.equal(p.snapshot("alice").length, 0);
  assert.equal(p.snapshot("bob").length, 1);
});

test("clearAll drops everything", () => {
  const p = createPerception();
  p.appendOne("alice", { kind: "speech" });
  p.appendOne("bob", { kind: "speech" });
  p.clearAll();
  assert.equal(p.snapshot("alice").length, 0);
  assert.equal(p.snapshot("bob").length, 0);
});

// ── formatPerceptionEvents ──

test("format: empty events yields empty string", () => {
  assert.equal(formatPerceptionEvents([]), "");
  assert.equal(formatPerceptionEvents(null), "");
});

test("format: speech rendered as 'Name: \"text\"'", () => {
  const out = formatPerceptionEvents([
    { kind: "speech", from_name: "Marisol", text: "good morning" },
  ]);
  assert.match(out, /Recent events:/);
  assert.match(out, /Marisol: "good morning"/);
});

test("format: speech addressed to self renders '(to you)'", () => {
  const out = formatPerceptionEvents(
    [{ kind: "speech", from_name: "Carlos", text: "you ok?", addressed_to_npub: "alice_npub" }],
    { selfPubkey: "alice_npub" },
  );
  assert.match(out, /Carlos \(to you\): "you ok\?"/);
});

test("format: speech addressed to other renders 'A → B: ...'", () => {
  const out = formatPerceptionEvents([
    {
      kind: "speech",
      from_name: "Carlos",
      text: "morning",
      addressed_to_npub: "bob_npub",
      addressed_to_name: "Bob",
    },
  ]);
  assert.match(out, /Carlos → Bob: "morning"/);
});

test("format: movement rendered with coords", () => {
  const out = formatPerceptionEvents([
    { kind: "movement", who_name: "Bob", x: 3, y: 7 },
  ]);
  assert.match(out, /Bob moved to \(3, 7\)/);
});

test("format: presence join/leave both rendered", () => {
  const out = formatPerceptionEvents([
    { kind: "presence", who_name: "Carlos", what: "joined" },
    { kind: "presence", who_name: "Bob", what: "left" },
  ]);
  assert.match(out, /Carlos joined the room/);
  assert.match(out, /Bob left the room/);
});

test("format: action_rejected mentions verb + reason", () => {
  const out = formatPerceptionEvents([
    { kind: "action_rejected", verb: "say_to", reason: "recipient not in scene" },
  ]);
  assert.match(out, /your attempt to say_to was rejected: recipient not in scene/);
});

test("format: need_low rendered with axis and value + flavor", () => {
  const out = formatPerceptionEvents([
    { kind: "need_low", axis: "energy", value: 22 },
  ]);
  assert.match(out, /your energy just dropped \(22\) — feeling drained/);
});

test("format: need_low for social uses social-specific flavor", () => {
  const out = formatPerceptionEvents([
    { kind: "need_low", axis: "social", value: 18 },
  ]);
  assert.match(out, /feeling withdrawn/);
});

test("format: need_low for energy uses energy-specific flavor", () => {
  const out = formatPerceptionEvents([
    { kind: "need_low", axis: "energy", value: 5 },
  ]);
  assert.match(out, /feeling drained/);
});

test("format: long speech truncated with ellipsis", () => {
  const long = "x".repeat(500);
  const out = formatPerceptionEvents([
    { kind: "speech", from_name: "Bob", text: long },
  ]);
  assert.ok(out.length < long.length, "should truncate long speech");
  assert.match(out, /…/);
});

test("format: unknown kinds are dropped", () => {
  const out = formatPerceptionEvents([
    { kind: "future-event-kind", data: "x" },
    { kind: "speech", from_name: "Bob", text: "hi" },
  ]);
  // Header + one rendered line only.
  assert.equal(out.split("\n").length, 2);
});

/**
 * Journal tests — scene record open/append/close + read-back.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/journal.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createJournal } from "../journal.js";

function inMemoryFs() {
  const store = new Map();
  return {
    _store: store,
    mkdirSync: () => {},
    appendFileSync: (p, c) => store.set(p, (store.get(p) ?? "") + String(c)),
    readFileSync: (p) => store.get(p) ?? "",
    existsSync: (p) => store.has(p),
  };
}

function fakeNow() {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
  };
}

const PARTICIPANTS = ["alice", "bob"];

// ── factory ──

test("createJournal requires workspacePath", () => {
  assert.throws(() => createJournal({}));
});

// ── openScene ──

test("openScene creates an in-progress record", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  j.openScene({ sceneId: "s1", participants: PARTICIPANTS, startedAt: 100, budget: 5 });
  const snap = j.openSnapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].scene_id, "s1");
  assert.equal(snap[0].turn_count, 0);
});

test("openScene is idempotent on the same id", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  j.openScene({ sceneId: "s1", participants: PARTICIPANTS });
  j.openScene({ sceneId: "s1", participants: PARTICIPANTS });
  assert.equal(j.openSnapshot().length, 1);
});

test("openScene rejects bad input", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  j.openScene({ sceneId: "", participants: PARTICIPANTS });
  j.openScene({ sceneId: "s1", participants: ["only-one"] });
  j.openScene({ sceneId: "s1", participants: null });
  assert.equal(j.openSnapshot().length, 0);
});

// ── appendTurn ──

test("appendTurn pushes structured turn entries", () => {
  const fs = inMemoryFs();
  const clock = fakeNow();
  const j = createJournal({ workspacePath: "/tmp/ws", fs, now: clock.now });
  j.openScene({ sceneId: "s1", participants: PARTICIPANTS, startedAt: 1000 });
  j.appendTurn("s1", {
    actor_pubkey: "alice",
    actor_name: "Alice",
    verb: "say",
    args: { text: "hi bob" },
  });
  clock.advance(2000);
  j.appendTurn("s1", {
    actor_pubkey: "bob",
    actor_name: "Bob",
    verb: "say",
    args: { text: "hey alice" },
  });
  // Close to flush.
  const closed = j.closeScene({ sceneId: "s1", endedAt: 4000, endReason: "budget" });
  assert.equal(closed.turns.length, 2);
  assert.equal(closed.turns[0].verb, "say");
  assert.equal(closed.turns[0].actor_name, "Alice");
  assert.equal(closed.turns[0].args.text, "hi bob");
  assert.equal(closed.turns[1].actor_name, "Bob");
  assert.ok(closed.turns[1].ts > closed.turns[0].ts);
});

test("appendTurn drops invalid turns silently", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  j.openScene({ sceneId: "s1", participants: PARTICIPANTS });
  j.appendTurn("s1", { actor_pubkey: "alice" }); // no verb
  j.appendTurn("s1", null);
  j.appendTurn("nonexistent", { verb: "say" });
  const closed = j.closeScene({ sceneId: "s1", endReason: "budget" });
  assert.equal(closed.turns.length, 0);
});

test("appendTurnForActor writes to every open scene the actor is in", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  j.openScene({ sceneId: "s_ab", participants: ["alice", "bob"] });
  j.openScene({ sceneId: "s_ac", participants: ["alice", "carol"] });
  j.openScene({ sceneId: "s_bc", participants: ["bob", "carol"] });
  j.appendTurnForActor("alice", { verb: "say", args: { text: "hi all" } });
  // alice's two scenes get the turn; bob<>carol does NOT.
  assert.equal(j.openSnapshot().find((s) => s.scene_id === "s_ab").turn_count, 1);
  assert.equal(j.openSnapshot().find((s) => s.scene_id === "s_ac").turn_count, 1);
  assert.equal(j.openSnapshot().find((s) => s.scene_id === "s_bc").turn_count, 0);
});

// ── closeScene ──

test("closeScene writes a JSONL line and clears in-memory", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  j.openScene({ sceneId: "s1", participants: PARTICIPANTS, startedAt: 1000, budget: 5 });
  j.appendTurn("s1", { verb: "say", args: { text: "hi" }, actor_pubkey: "alice" });
  j.closeScene({ sceneId: "s1", endedAt: 2000, endReason: "budget" });
  // In-memory cleared.
  assert.equal(j.openSnapshot().length, 0);
  // JSONL written with a newline.
  const text = fs._store.get("/tmp/ws/scenes.jsonl");
  assert.ok(text);
  assert.ok(text.endsWith("\n"));
  const rec = JSON.parse(text.trim());
  assert.equal(rec.scene_id, "s1");
  assert.equal(rec.end_reason, "budget");
  assert.equal(rec.ts_end, 2000);
  assert.equal(rec.turns.length, 1);
});

test("closeScene on unknown id is a no-op", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  const out = j.closeScene({ sceneId: "ghost", endReason: "budget" });
  assert.equal(out, null);
  assert.equal(fs._store.size, 0);
});

// ── read-back ──

test("listScenes returns all closed scenes, newest first", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  for (let i = 0; i < 3; i++) {
    j.openScene({ sceneId: `s${i}`, participants: PARTICIPANTS, startedAt: 1000 + i });
    j.closeScene({ sceneId: `s${i}`, endedAt: 2000 + i, endReason: "budget" });
  }
  const list = j.listScenes();
  assert.equal(list.length, 3);
  assert.equal(list[0].scene_id, "s2");
  assert.equal(list[2].scene_id, "s0");
});

test("listScenes: limit", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  for (let i = 0; i < 5; i++) {
    j.openScene({ sceneId: `s${i}`, participants: PARTICIPANTS, startedAt: 1000 + i });
    j.closeScene({ sceneId: `s${i}`, endedAt: 2000 + i, endReason: "budget" });
  }
  assert.equal(j.listScenes({ limit: 2 }).length, 2);
});

test("listScenes: filter by participant", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  j.openScene({ sceneId: "s1", participants: ["alice", "bob"], startedAt: 1000 });
  j.closeScene({ sceneId: "s1", endedAt: 2000, endReason: "budget" });
  j.openScene({ sceneId: "s2", participants: ["bob", "carol"], startedAt: 1500 });
  j.closeScene({ sceneId: "s2", endedAt: 2500, endReason: "budget" });
  const aliceList = j.listScenes({ participant: "alice" });
  assert.equal(aliceList.length, 1);
  assert.equal(aliceList[0].scene_id, "s1");
  const bobList = j.listScenes({ participant: "bob" });
  assert.equal(bobList.length, 2);
});

test("listScenes: before timestamp", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  for (let i = 0; i < 3; i++) {
    j.openScene({ sceneId: `s${i}`, participants: PARTICIPANTS, startedAt: 1000 + 1000 * i });
    j.closeScene({ sceneId: `s${i}`, endedAt: 1500 + 1000 * i, endReason: "budget" });
  }
  const before2500 = j.listScenes({ before: 2500 });
  // s0 ts_start=1000 ✓, s1 ts_start=2000 ✓, s2 ts_start=3000 ✗
  assert.equal(before2500.length, 2);
});

test("getScene: in-progress scenes are returned from memory", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  j.openScene({ sceneId: "live", participants: PARTICIPANTS });
  j.appendTurn("live", { verb: "say", args: { text: "still talking" } });
  const rec = j.getScene("live");
  assert.equal(rec.scene_id, "live");
  assert.equal(rec.ts_end, null);
  assert.equal(rec.turns.length, 1);
});

test("getScene: closed scenes are returned from disk", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  j.openScene({ sceneId: "done", participants: PARTICIPANTS });
  j.closeScene({ sceneId: "done", endReason: "budget", endedAt: 5000 });
  const rec = j.getScene("done");
  assert.equal(rec.scene_id, "done");
  assert.equal(rec.end_reason, "budget");
});

test("getScene: unknown id returns null", () => {
  const fs = inMemoryFs();
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  assert.equal(j.getScene("ghost"), null);
});

// ── resilience ──

test("listScenes tolerates malformed lines", () => {
  const fs = inMemoryFs();
  fs.appendFileSync(
    "/tmp/ws/scenes.jsonl",
    JSON.stringify({ scene_id: "good1", participants: PARTICIPANTS, ts_start: 1, ts_end: 2 }) + "\n" +
    "this is not json\n" +
    JSON.stringify({ scene_id: "good2", participants: PARTICIPANTS, ts_start: 3, ts_end: 4 }) + "\n",
  );
  const j = createJournal({ workspacePath: "/tmp/ws", fs });
  const list = j.listScenes();
  assert.equal(list.length, 2);
});

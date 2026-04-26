/**
 * Scene-tracker tests. Stateful conversation gate over scenes.js.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/scene-tracker.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSceneTracker, DEFAULTS } from "../scene-tracker.js";

const NEAR = {
  agents: [
    { npub: "alice", name: "Alice", x: 5, y: 5 },
    { npub: "bob",   name: "Bob",   x: 6, y: 5 },
  ],
};
const FAR = {
  agents: [
    { npub: "alice", name: "Alice", x: 5, y: 5 },
    { npub: "bob",   name: "Bob",   x: 15, y: 15 },
  ],
};
const TRIO_NEAR = {
  agents: [
    { npub: "alice", name: "Alice", x: 5, y: 5 },
    { npub: "bob",   name: "Bob",   x: 6, y: 5 },
    { npub: "carol", name: "Carol", x: 5, y: 6 },
  ],
};

function fakeNow() {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
  };
}

function fixedRandom(seq) {
  let i = 0;
  return () => {
    const v = seq[i % seq.length];
    i++;
    return v;
  };
}

// ── factory ──

test("createSceneTracker: undefined opts don't overwrite defaults", () => {
  // env-pass-through commonly produces `Number(env) || undefined` for
  // unset vars. We must keep the defaults in that case.
  const t = createSceneTracker({
    budgetMin: undefined,
    budgetMax: undefined,
    hardCap: undefined,
    random: () => 0,
  });
  t.onSnapshot(NEAR);
  const scenes = t.activeScenesFor("alice");
  assert.equal(scenes.length, 1);
  // budget must be a finite number (not null/NaN/undefined).
  assert.ok(Number.isFinite(scenes[0].budget), `budget should be finite, got ${scenes[0].budget}`);
  assert.ok(scenes[0].budget >= DEFAULTS.budgetMin && scenes[0].budget <= DEFAULTS.budgetMax);
});

// ── snapshot lifecycle ──

test("onSnapshot: opens a scene for newly-proximate pair", () => {
  const clock = fakeNow();
  const t = createSceneTracker({ now: clock.now, random: () => 0 });
  const r = t.onSnapshot(NEAR);
  assert.equal(r.opened.length, 1);
  assert.equal(r.closed.length, 0);
  assert.deepEqual(r.opened[0].participants.sort(), ["alice", "bob"]);
  assert.equal(t.activeScenesFor("alice").length, 1);
  assert.equal(t.activeScenesFor("bob").length, 1);
});

test("onSnapshot: idempotent — second call doesn't open duplicate", () => {
  const t = createSceneTracker({ random: () => 0 });
  t.onSnapshot(NEAR);
  const r = t.onSnapshot(NEAR);
  assert.equal(r.opened.length, 0);
  assert.equal(t.activeScenesFor("alice").length, 1);
});

test("onSnapshot: closes scene when proximity is lost", () => {
  const t = createSceneTracker({ random: () => 0 });
  t.onSnapshot(NEAR);
  const r = t.onSnapshot(FAR);
  assert.equal(r.closed.length, 1);
  assert.equal(r.closed[0].reason, "proximity_lost");
  assert.equal(t.activeScenesFor("alice").length, 0);
});

test("onSnapshot: cooldown blocks re-open after proximity_lost", () => {
  const clock = fakeNow();
  const t = createSceneTracker({ now: clock.now, random: () => 0, cooldownMs: 60_000 });
  t.onSnapshot(NEAR);
  t.onSnapshot(FAR);
  // They re-approach immediately — should NOT open a new scene.
  const r = t.onSnapshot(NEAR);
  assert.equal(r.opened.length, 0);
  assert.ok(t.isOnCooldown("alice", "bob"));
  // After cooldown elapses, next onSnapshot opens fresh.
  clock.advance(60_001);
  const r2 = t.onSnapshot(NEAR);
  assert.equal(r2.opened.length, 1);
  assert.ok(!t.isOnCooldown("alice", "bob"));
});

test("onSnapshot: trio opens three pair scenes", () => {
  const t = createSceneTracker({ random: () => 0 });
  const r = t.onSnapshot(TRIO_NEAR);
  assert.equal(r.opened.length, 3); // A-B, A-C, B-C
});

// ── budget close ──

test("recordAction: speech increments turn count; reaches budget then closes", () => {
  // Force budget = 4 (smallest possible with default range).
  const t = createSceneTracker({ random: () => 0, budgetMin: 4, budgetMax: 4 });
  t.onSnapshot(NEAR);
  for (let i = 0; i < 3; i++) {
    const closed = t.recordAction("alice", "say");
    assert.equal(closed.length, 0);
  }
  // 4th say crosses the budget.
  const closed = t.recordAction("alice", "say");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, "budget");
  assert.ok(t.isOnCooldown("alice", "bob"));
});

test("recordAction: non-speech does not increment turn count", () => {
  const t = createSceneTracker({ random: () => 0, budgetMin: 4, budgetMax: 4 });
  t.onSnapshot(NEAR);
  for (let i = 0; i < 10; i++) t.recordAction("alice", "move");
  assert.equal(t.activeScenesFor("alice").length, 1);
  assert.equal(t.activeScenesFor("alice")[0].turns, 0);
});

test("recordAction: hard cap closes scene even if budget is high", () => {
  const t = createSceneTracker({ random: () => 0, budgetMin: 100, budgetMax: 100, hardCap: 3 });
  t.onSnapshot(NEAR);
  t.recordAction("alice", "say");
  t.recordAction("bob", "say");
  const closed = t.recordAction("alice", "say");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, "hard_cap");
});

// ── soft stop ──

test("recordAction: soft_stop fires when both participants run quiet", () => {
  const t = createSceneTracker({ random: () => 0, softStopRun: 2 });
  t.onSnapshot(NEAR);
  t.recordAction("alice", "say");
  t.recordAction("alice", "wait");
  // Alice has quiet=1, Bob has quiet=0. No close.
  assert.equal(t.activeScenesFor("alice").length, 1);
  t.recordAction("alice", "wait");
  // Alice quiet=2, Bob quiet=0 — soft stop needs BOTH.
  assert.equal(t.activeScenesFor("alice").length, 1);
  t.recordAction("bob", "idle");
  t.recordAction("bob", "idle");
  // Bob quiet=2, Alice quiet=2 → close on the action that brought Bob to 2.
  // The close happens in the LAST recordAction's loop.
  assert.equal(t.activeScenesFor("alice").length, 0);
  assert.ok(t.isOnCooldown("alice", "bob"));
});

test("recordAction: speech resets soft_stop run", () => {
  const t = createSceneTracker({ random: () => 0, softStopRun: 2 });
  t.onSnapshot(NEAR);
  t.recordAction("alice", "wait");
  t.recordAction("alice", "wait"); // alice quiet=2
  t.recordAction("bob", "wait");   // bob quiet=1
  t.recordAction("alice", "say");  // alice quiet resets to 0
  t.recordAction("bob", "wait");   // bob quiet=2
  // Alice is back to 0 — no soft_stop fires.
  assert.equal(t.activeScenesFor("alice").length, 1);
});

// ── effective helpers ──

test("effectiveInScene: respects cooldown", () => {
  const clock = fakeNow();
  const t = createSceneTracker({ now: clock.now, random: () => 0, cooldownMs: 60_000 });
  t.onSnapshot(NEAR);
  // No cooldown yet — effective matches raw.
  assert.equal(t.effectiveInScene(NEAR, "alice", "bob"), true);
  // Force a budget close.
  for (let i = 0; i < 4; i++) t.recordAction("alice", "say");
  // Now on cooldown — effective says no.
  assert.equal(t.effectiveInScene(NEAR, "alice", "bob"), false);
  // After cooldown, raw proximity rules again.
  clock.advance(60_001);
  assert.equal(t.effectiveInScene(NEAR, "alice", "bob"), true);
});

test("effectiveSceneMatesOf: filters cooldown'd peers", () => {
  // Set up: alice<>bob on cooldown via proximity_lost; carol comes in
  // fresh. The raw proximity helper sees all three as scene-mates of
  // alice, but the tracker subtracts bob.
  const clock = fakeNow();
  const t = createSceneTracker({ now: clock.now, random: () => 0, cooldownMs: 60_000 });
  t.onSnapshot(NEAR);            // open alice<>bob
  t.onSnapshot(FAR);             // close → cooldown
  // Now bring everyone together. Carol just arrived; alice<>carol
  // opens fresh; alice<>bob is still cooled down so doesn't reopen.
  const r = t.onSnapshot(TRIO_NEAR);
  assert.ok(r.opened.length >= 1);
  assert.ok(t.isOnCooldown("alice", "bob"));
  const mates = t.effectiveSceneMatesOf(TRIO_NEAR, "alice");
  assert.deepEqual(mates.sort(), ["carol"]);
});

// ── isOnCooldown ──

test("isOnCooldown: order-independent pair lookup", () => {
  const t = createSceneTracker({ random: () => 0, budgetMin: 4, budgetMax: 4 });
  t.onSnapshot(NEAR);
  for (let i = 0; i < 4; i++) t.recordAction("alice", "say");
  assert.ok(t.isOnCooldown("alice", "bob"));
  assert.ok(t.isOnCooldown("bob", "alice"));
});

test("isOnCooldown: false for unrelated pair", () => {
  const t = createSceneTracker({ random: () => 0 });
  assert.equal(t.isOnCooldown("ghost", "phantom"), false);
});

// ── clearCharacter ──

test("clearCharacter: drops scenes for that character", () => {
  const t = createSceneTracker({ random: () => 0 });
  t.onSnapshot(TRIO_NEAR);
  assert.equal(t.activeScenesFor("alice").length, 2);
  t.clearCharacter("alice");
  assert.equal(t.activeScenesFor("alice").length, 0);
  // Bob still has scene with carol.
  assert.equal(t.activeScenesFor("bob").length, 1);
});

// ── snapshot state ──

test("snapshot: reports scenes + cooldowns + quiet runs", () => {
  const clock = fakeNow();
  const t = createSceneTracker({ now: clock.now, random: () => 0, cooldownMs: 60_000 });
  t.onSnapshot(NEAR);
  t.recordAction("alice", "wait");
  const snap = t.snapshot();
  assert.equal(snap.scenes.length, 1);
  assert.equal(snap.cooldowns.length, 0);
  // Force budget close → cooldown.
  for (let i = 0; i < 4; i++) t.recordAction("bob", "say");
  const snap2 = t.snapshot();
  assert.equal(snap2.scenes.length, 0);
  assert.equal(snap2.cooldowns.length, 1);
  assert.ok(snap2.cooldowns[0].msRemaining > 0);
});

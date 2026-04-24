/**
 * ExternalHarness tests. Exercises the token, SSE attach, action
 * recording, rate limit, and heartbeat paths without starting a
 * real HTTP server.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/external-harness.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createExternalHarness, signToken, verifyToken } from "../harnesses/external.js";

const SECRET = "test-secret-hex";

function newHarness(overrides = {}) {
  let t = 1_000_000;
  return createExternalHarness({
    secret: overrides.secret ?? SECRET,
    now: overrides.now ?? (() => (t += 1)),
  });
}

async function start(h, overrides = {}) {
  await h.start({
    agentId: overrides.agentId ?? "ag_ext",
    pubkey: overrides.pubkey ?? "ff".repeat(32),
    systemPrompt: overrides.systemPrompt ?? "you are external",
    provider: overrides.provider ?? "caller-pick",
    model: overrides.model ?? "caller-pick",
    onEvent: overrides.onEvent ?? (() => {}),
  });
}

// ── token ──

test("token: signs and verifies round-trip", () => {
  const payload = { agentId: "ag_t", pubkey: "aa", iat: 1000, exp: 2000 };
  const tok = signToken(payload, SECRET);
  const back = verifyToken(tok, SECRET, 1500);
  assert.deepEqual(back, payload);
});

test("token: rejects tampered signature", () => {
  const tok = signToken({ a: 1, exp: 9e12 }, SECRET);
  const [enc, sig] = tok.split(".");
  const mutated = `${enc}.${"0".repeat(sig.length)}`;
  assert.equal(verifyToken(mutated, SECRET), null);
});

test("token: rejects wrong secret", () => {
  const tok = signToken({ a: 1, exp: 9e12 }, SECRET);
  assert.equal(verifyToken(tok, "different"), null);
});

test("token: rejects expired", () => {
  const tok = signToken({ a: 1, exp: 100 }, SECRET);
  assert.equal(verifyToken(tok, SECRET, 200), null);
});

test("token: rejects garbage", () => {
  assert.equal(verifyToken("not-a-token", SECRET), null);
  assert.equal(verifyToken("", SECRET), null);
  assert.equal(verifyToken(null, SECRET), null);
  assert.equal(verifyToken("a.b", SECRET), null);
});

// ── harness lifecycle ──

test("harness: refuses to start without secret", async () => {
  const h = createExternalHarness({ secret: "" });
  await assert.rejects(
    () => h.start({ agentId: "x", pubkey: "y", systemPrompt: "", provider: "p", model: "m" }),
    /AGENT_TOKEN_SECRET not configured/,
  );
});

test("harness: start() issues a valid token", async () => {
  const h = newHarness();
  await start(h);
  const tok = h.getToken();
  assert.ok(tok);
  assert.ok(h.verifyToken(tok));
});

test("harness: verifyToken rejects mismatched agentId", async () => {
  const h = newHarness();
  await start(h, { agentId: "ag_a" });
  // Sign a token with a different agentId but same secret.
  const foreign = signToken({ agentId: "ag_b", pubkey: "ff".repeat(32), iat: 1, exp: 9e12 }, SECRET);
  assert.equal(h.verifyToken(foreign), null);
});

// ── SSE + turn flow ──

test("harness: turn waits for matching act", async () => {
  const h = newHarness();
  const written = [];
  const res = { write: (s) => written.push(s), end: () => {}, flushHeaders: () => {} };
  await start(h);
  h.attachStream({ res });

  const turnPromise = h.turn("hello");
  // Allow microtask flush so turn_request is emitted.
  await new Promise((r) => setImmediate(r));

  const joined = written.some((w) => w.includes("event: turn_request"));
  assert.ok(joined, "turn_request should be emitted on SSE stream");

  // Dig the turnId out of the emitted event.
  const turnIdMatch = written.join("\n").match(/"turnId":"(t\d+)"/);
  assert.ok(turnIdMatch, "turn_request should include turnId");
  const turnId = turnIdMatch[1];

  const result = h.recordAct({ turnId, text: "hi back", move: { x: 4, y: 5 }, state: "calm" });
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 3);

  const turn = await turnPromise;
  assert.equal(turn.actions.length, 3);
  assert.equal(turn.actions[0].type, "say");
  assert.equal(turn.actions[0].text, "hi back");
});

test("harness: stale turnId rejected", async () => {
  const h = newHarness();
  await start(h);
  h.attachStream({ res: { write: () => {}, end: () => {}, flushHeaders: () => {} } });
  const turnPromise = h.turn("hello");
  await new Promise((r) => setImmediate(r));
  const bogus = h.recordAct({ turnId: "t999", text: "no" });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.code, 409);
  // Clean up the pending turn so the test doesn't hang.
  h.recordAct({ turnId: "t1", text: "done" });
  await turnPromise;
});

test("harness: act without pending turn returns 409", async () => {
  const h = newHarness();
  await start(h);
  const r = h.recordAct({ turnId: "anything" });
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
});

test("harness: heartbeat updates idle flag", async () => {
  let t = 1_000_000;
  const h = createExternalHarness({
    secret: SECRET,
    now: () => t,
  });
  await h.start({
    agentId: "ag_hb",
    pubkey: "ff".repeat(32),
    systemPrompt: "",
    provider: "p",
    model: "m",
  });
  // Default heartbeat timeout is 5 min. Idle check at t+6min ⇒ too long.
  t += 6 * 60_000;
  assert.equal(h.isIdleTooLong(), true);
  h.touchHeartbeat();
  assert.equal(h.isIdleTooLong(), false);
});

test("harness: rate limit on /act", async () => {
  const h = newHarness();
  await start(h);
  const res = { write: () => {}, end: () => {}, flushHeaders: () => {} };
  h.attachStream({ res });
  for (let i = 0; i < 20; i++) {
    const p = h.turn(`q${i}`);
    await new Promise((r) => setImmediate(r));
    const ok = h.recordAct({ turnId: `t${i + 1}`, text: `r${i}` });
    assert.equal(ok.ok, true, `act #${i} should succeed`);
    await p;
  }
  const next = h.turn("one more");
  await new Promise((r) => setImmediate(r));
  const blocked = h.recordAct({ turnId: "t21", text: "blocked" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 429);
  // Stop the harness to cancel the pending turn promise cleanly — the
  // rate limiter gated subsequent acts, so the 21st turn would
  // otherwise hang for TURN_TIMEOUT_MS. stop() rejects it immediately.
  await h.stop();
  await next.catch(() => {});
});

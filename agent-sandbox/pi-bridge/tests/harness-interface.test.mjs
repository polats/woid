/**
 * Smoke tests for the Harness interface + factory. Validates the shape
 * contract without needing a real pi subprocess or LLM. Each harness
 * implementation additionally has its own integration test.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/harness-interface.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createHarness, KNOWN_HARNESSES, DEFAULT_HARNESS } from "../harnesses/index.js";
import { createPiHarness } from "../harnesses/pi.js";

test("factory: throws on unknown harness", () => {
  assert.throws(() => createHarness("bogus"), /unknown harness/);
});

test("factory: default is pi and is in KNOWN_HARNESSES", () => {
  assert.equal(DEFAULT_HARNESS, "pi");
  assert.ok(KNOWN_HARNESSES.includes("pi"));
});

test("factory: createHarness('pi') returns a pi-shaped object", () => {
  const h = createHarness("pi");
  assert.equal(h.name, "pi");
  assert.equal(typeof h.start, "function");
  assert.equal(typeof h.turn, "function");
  assert.equal(typeof h.stop, "function");
  assert.equal(typeof h.snapshot, "function");
});

test("pi harness: start/turn/stop lifecycle with stubbed pool", async () => {
  const events = [];
  const startedArgs = [];
  const stubHandle = {
    async turn(userTurn) {
      return {
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "stub thoughts" },
            { type: "text", text: "hello" },
          ],
          usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } },
        },
      };
    },
  };
  let running = true;
  const deps = {
    startPi: (opts) => {
      startedArgs.push(opts);
      return stubHandle;
    },
    getPi: () => (running ? stubHandle : null),
    stopPi: () => { running = false; return true; },
    restartHandle: (_id, patch) => {
      startedArgs.push({ restart: true, ...patch });
      return stubHandle;
    },
  };

  const h = createPiHarness(deps);
  await h.start({
    agentId: "ag_test",
    pubkey: "deadbeef",
    systemPrompt: "you are a test agent",
    provider: "google",
    model: "gemini-2.5-flash",
    sessionPath: "/tmp/woid-test/session.jsonl",
    cwd: "/tmp/woid-test",
    env: {},
    onEvent: (ev) => events.push(ev),
  });

  const result = await h.turn("say hi");
  assert.deepEqual(result.actions, []);
  assert.equal(result.thinking, "stub thoughts");
  assert.equal(result.usage?.totalTokens, 15);

  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("turn_start"));
  assert.ok(kinds.includes("turn_end"));

  await h.stop();
  assert.equal(running, false);
});

test("pi harness: system prompt drift triggers restart", async () => {
  const log = [];
  const stubHandle = {
    async turn() {
      return { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
    },
  };
  let current = null;
  const deps = {
    startPi: (o) => { log.push({ k: "start", sysPrompt: o.systemPrompt }); current = stubHandle; return stubHandle; },
    getPi: () => current,
    stopPi: () => { current = null; return true; },
    restartHandle: (_id, patch) => { log.push({ k: "restart", sysPrompt: patch.systemPrompt }); current = stubHandle; return stubHandle; },
  };
  const h = createPiHarness(deps);
  await h.start({
    agentId: "ag_drift",
    pubkey: "aa",
    systemPrompt: "prompt v1",
    provider: "google",
    model: "gemini-2.5-flash",
  });
  await h.turn("x");                              // lazy-spawn on first turn
  h.updateSystemPrompt("prompt v2");
  await h.turn("y");                              // should trigger restart
  const kinds = log.map((l) => l.k);
  assert.deepEqual(kinds, ["start", "restart"]);
  assert.equal(log[1].sysPrompt, "prompt v2");
});

test("pi harness: turn error propagates", async () => {
  const stubHandle = {
    async turn() { throw new Error("boom"); },
  };
  const h = createPiHarness({
    startPi: () => stubHandle,
    getPi: () => stubHandle,
    stopPi: () => true,
    restartHandle: () => stubHandle,
  });
  await h.start({
    agentId: "ag_err",
    pubkey: "cc",
    systemPrompt: "hi",
    provider: "google",
    model: "gemini-2.5-flash",
  });
  await assert.rejects(() => h.turn("go"), /boom/);
});

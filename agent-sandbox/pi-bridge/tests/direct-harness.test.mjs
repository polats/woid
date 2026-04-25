/**
 * DirectHarness tests. Exercise the action parser + the full turn loop
 * with a stubbed provider so we don't need a real API key to run.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/direct-harness.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDirectHarness, _parseActions } from "../harnesses/direct.js";

// ── parser — legacy keyed shape (still emitted by older characters) ──

test("parse legacy: keyed JSON produces all three actions in new shape", () => {
  const raw = JSON.stringify({ thinking: "x", say: "hi", move: { x: 1, y: 2 }, state: "curious" });
  const r = _parseActions(raw);
  assert.equal(r.thinking, "x");
  assert.equal(r.actions.length, 3);
  assert.ok(r.actions.find((a) => a.verb === "say" && a.args.text === "hi"));
  assert.ok(r.actions.find((a) => a.verb === "move" && a.args.x === 1 && a.args.y === 2));
  assert.ok(r.actions.find((a) => a.verb === "set_state" && a.args.value === "curious"));
});

test("parse: empty object yields no actions and no error", () => {
  const r = _parseActions("{}");
  assert.deepEqual(r.actions, []);
  assert.equal(r.error, undefined);
  assert.equal(r.thinking, undefined);
});

test("parse legacy: markdown-fenced JSON is tolerated", () => {
  const raw = "```json\n{\"say\":\"hello\"}\n```";
  const r = _parseActions(raw);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].verb, "say");
  assert.equal(r.actions[0].args.text, "hello");
});

test("parse: extracts JSON from prose-surrounded response", () => {
  const raw = "Sure! Here you go:\n{\"say\": \"howdy\"}\nThanks.";
  const r = _parseActions(raw);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].args.text, "howdy");
});

test("parse: bad JSON returns error", () => {
  const r = _parseActions("{ not valid");
  assert.ok(r.error, "expected an error field");
});

test("parse: empty string returns error", () => {
  const r = _parseActions("");
  assert.equal(r.actions.length, 0);
  assert.ok(r.error);
});

test("parse legacy: move with non-numeric coords is dropped", () => {
  const r = _parseActions(JSON.stringify({ move: { x: "a", y: 3 } }));
  assert.equal(r.actions.length, 0);
});

test("parse legacy: say is truncated to 1000 chars", () => {
  const long = "a".repeat(2000);
  const r = _parseActions(JSON.stringify({ say: long }));
  assert.equal(r.actions[0].args.text.length, 1000);
});

test("parse legacy: strings are trimmed", () => {
  const r = _parseActions(JSON.stringify({ say: "  hi  " }));
  assert.equal(r.actions[0].args.text, "hi");
});

test("parse: nested quotes don't break extraction", () => {
  const raw = '{"say": "she said \\"hello\\""}';
  const r = _parseActions(raw);
  assert.equal(r.actions[0].args.text, 'she said "hello"');
});

test("parse legacy: mood lever parsed and clamped to 0–100", () => {
  const r = _parseActions(JSON.stringify({ mood: { energy: 75, social: 40 } }));
  const m = r.actions.find((a) => a.verb === "set_mood");
  assert.ok(m);
  assert.deepEqual(m.args, { energy: 75, social: 40 });
});

test("parse legacy: mood out-of-range values clamp to bounds", () => {
  const r = _parseActions(JSON.stringify({ mood: { energy: 200, social: -50 } }));
  const m = r.actions.find((a) => a.verb === "set_mood");
  assert.deepEqual(m.args, { energy: 100, social: 0 });
});

test("parse legacy: mood with one key only includes that key", () => {
  const r = _parseActions(JSON.stringify({ mood: { energy: 30 } }));
  const m = r.actions.find((a) => a.verb === "set_mood");
  assert.deepEqual(m.args, { energy: 30 });
});

test("parse legacy: mood with no numeric values yields no mood action", () => {
  const r = _parseActions(JSON.stringify({ mood: { energy: "high", social: null } }));
  assert.equal(r.actions.find((a) => a.verb === "set_mood"), undefined);
});

// ── parser — new {actions: [{verb, args}, ...]} shape ──

test("parse new: structured actions array passes through", () => {
  const raw = JSON.stringify({
    thinking: "weighing options",
    actions: [
      { verb: "say", args: { text: "hi" } },
      { verb: "post", args: { text: "morning, internet" } },
      { verb: "move", args: { x: 4, y: 5 } },
    ],
  });
  const r = _parseActions(raw);
  assert.equal(r.thinking, "weighing options");
  assert.equal(r.actions.length, 3);
  assert.equal(r.actions[0].verb, "say");
  assert.equal(r.actions[0].args.text, "hi");
  assert.equal(r.actions[1].verb, "post");
  assert.equal(r.actions[1].args.text, "morning, internet");
  assert.equal(r.actions[2].verb, "move");
  assert.equal(r.actions[2].args.x, 4);
});

test("parse new: drops entries without a verb", () => {
  const raw = JSON.stringify({
    actions: [
      { verb: "say", args: { text: "ok" } },
      { args: { text: "missing verb" } },
      { verb: "", args: { text: "empty verb" } },
      "not an object",
    ],
  });
  const r = _parseActions(raw);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].verb, "say");
});

test("parse new: missing args becomes empty object", () => {
  const raw = JSON.stringify({ actions: [{ verb: "idle" }] });
  const r = _parseActions(raw);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].verb, "idle");
  assert.deepEqual(r.actions[0].args, {});
});

test("parse new: all ten verbs flow through unchanged", () => {
  const verbs = ["say", "say_to", "move", "face", "wait", "emote", "set_state", "set_mood", "post", "idle"];
  const raw = JSON.stringify({
    actions: verbs.map((v) => ({ verb: v, args: { sample: "x" } })),
  });
  const r = _parseActions(raw);
  assert.equal(r.actions.length, verbs.length);
  for (const v of verbs) {
    assert.ok(r.actions.find((a) => a.verb === v));
  }
});

test("parse new: array shape takes precedence over keyed shape", () => {
  // If both are present (transitional output), prefer the new shape.
  const raw = JSON.stringify({
    say: "from-keyed",
    actions: [{ verb: "say", args: { text: "from-actions" } }],
  });
  const r = _parseActions(raw);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].args.text, "from-actions");
});

// ── harness turn lifecycle ──

test("harness: start/turn/stop with stubbed provider", async () => {
  const calls = [];
  const fakeFs = _inMemoryFs();
  const h = createDirectHarness({
    generateJson: async (opts) => {
      calls.push(opts);
      return {
        text: JSON.stringify({ thinking: "stub thought", say: "stub reply" }),
        usage: { input: 50, output: 20, totalTokens: 70 },
      };
    },
    fs: fakeFs,
  });

  const events = [];
  await h.start({
    agentId: "ag_d1",
    pubkey: "aabb",
    systemPrompt: "you are a tester",
    provider: "google",
    model: "gemini-2.5-flash",
    sessionPath: "/tmp/direct-test/session.jsonl",
    env: { GEMINI_API_KEY: "stub" },
    onEvent: (ev) => events.push(ev),
  });

  const r = await h.turn("ping");
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].verb, "say");
  assert.equal(r.actions[0].args.text, "stub reply");
  assert.equal(r.thinking, "stub thought");
  assert.equal(r.usage.totalTokens, 70);

  // Provider was called with the right context.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "google");
  assert.equal(calls[0].model, "gemini-2.5-flash");
  assert.ok(calls[0].systemPrompt.includes("you are a tester"));
  assert.equal(calls[0].messages[0].role, "user");
  assert.equal(calls[0].messages[0].content, "ping");

  // History persisted.
  const jsonlPath = "/tmp/direct-test/turns.jsonl";
  assert.ok(fakeFs._store.has(jsonlPath));
  const lines = fakeFs._store.get(jsonlPath).split("\n").filter(Boolean);
  assert.equal(lines.length, 2); // user + assistant

  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("turn_start"));
  assert.ok(kinds.includes("action"));
  assert.ok(kinds.includes("turn_end"));

  await h.stop();
  assert.equal(h.snapshot().running, false);
});

test("harness: provider error propagates", async () => {
  const h = createDirectHarness({
    generateJson: async () => { throw new Error("429 rate limit"); },
    fs: _inMemoryFs(),
  });
  await h.start({
    agentId: "ag_d_err",
    pubkey: "cc",
    systemPrompt: "x",
    provider: "nim",
    model: "meta/llama-3.1-8b-instruct",
  });
  await assert.rejects(() => h.turn("hi"), /429/);
});

test("harness: malformed response yields no actions but no throw", async () => {
  const h = createDirectHarness({
    generateJson: async () => ({ text: "totally not json", usage: {} }),
    fs: _inMemoryFs(),
  });
  await h.start({
    agentId: "ag_d_junk",
    pubkey: "dd",
    systemPrompt: "x",
    provider: "google",
    model: "gemini-2.5-flash",
  });
  const r = await h.turn("hi");
  assert.deepEqual(r.actions, []);
  assert.ok(r.error, "should surface parse error");
});

test("harness: history restored from existing turns.jsonl", async () => {
  const fakeFs = _inMemoryFs();
  const sessionPath = "/tmp/direct-r/turns.jsonl";
  const priorPath = "/tmp/direct-r/turns.jsonl";
  fakeFs._store.set(
    priorPath,
    JSON.stringify({ role: "user", content: "earlier-user" }) +
      "\n" +
      JSON.stringify({ role: "assistant", content: "earlier-assistant" }) +
      "\n",
  );
  const captured = [];
  const h = createDirectHarness({
    generateJson: async (opts) => {
      captured.push(opts.messages);
      return { text: "{}", usage: {} };
    },
    fs: fakeFs,
  });
  await h.start({
    agentId: "ag_r",
    pubkey: "ee",
    systemPrompt: "x",
    provider: "google",
    model: "gemini-2.5-flash",
    sessionPath,
  });
  await h.turn("now");
  // Provider should have seen the restored history + the new user msg.
  const sent = captured[0];
  assert.equal(sent.length, 3);
  assert.equal(sent[0].content, "earlier-user");
  assert.equal(sent[1].content, "earlier-assistant");
  assert.equal(sent[2].content, "now");
});

// ── factory ──
test("factory: direct harness is pickable", async () => {
  const mod = await import("../harnesses/index.js");
  assert.ok(mod.KNOWN_HARNESSES.includes("direct"));
  const h = mod.createHarness("direct", { generateJson: async () => ({ text: "{}" }), fs: _inMemoryFs() });
  assert.equal(h.name, "direct");
});

// ── helpers ──
function _inMemoryFs() {
  const store = new Map();
  return {
    _store: store,
    existsSync: (p) => store.has(p),
    readFileSync: (p) => store.get(p) ?? "",
    writeFileSync: (p, c) => store.set(p, String(c)),
    appendFileSync: (p, c) => store.set(p, (store.get(p) ?? "") + String(c)),
    mkdirSync: () => {},
  };
}

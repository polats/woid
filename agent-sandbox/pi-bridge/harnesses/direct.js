/**
 * DirectHarness — call-my-ghost style: one provider SDK call per turn,
 * expects a JSON response conforming to the Action schema, returns
 * parsed actions to the bridge. No subprocess, no shell, no loopback.
 *
 * Session = in-memory rolling history capped at MAX_HISTORY_TURNS,
 * mirrored to a `turns.jsonl` alongside pi's session so the inspector
 * can still render something useful. Each entry one JSON line.
 *
 * Action schema (documented in system prompt; enforced by JSON.parse):
 *   {
 *     "thinking": string?,            // agent-facing scratchpad
 *     "say":      string?,             // room message
 *     "move":     { "x": int, "y": int }?,
 *     "state":    string?              // short mood/context
 *   }
 * Missing keys = no action of that type. Extra keys = ignored.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as providers from "../providers/index.js";

// Cap on how much rolling history we send each turn. Call-my-ghost
// slices to 4 utterances + 10 perceptions; 20 assistant turns is a
// comparable budget for our shape. Tune via env.
const MAX_HISTORY_TURNS = Number(process.env.DIRECT_HISTORY_TURNS || 20);

// The output contract / action schema is now built into the system
// prompt by buildSystemPrompt itself, parameterised by promptStyle.
// Kept exported as a no-op for back-compat with anything that still
// imports it (the system-prompt endpoint stopped using it).
export const DIRECT_SCHEMA_HINT = "";

export function createDirectHarness(deps = {}) {
  const gen = deps.generateJson ?? providers.generateJson;
  const fs = deps.fs ?? { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync };

  let agentId = null;
  let systemPrompt = "";
  let provider = null;
  let model = null;
  let sessionPath = null;
  let env = null;
  let onEvent = () => {};
  /** @type {Array<{role:'user'|'assistant',content:string}>} */
  let history = [];
  let turns = 0;
  let running = false;
  let stopped = false;

  const harness = {
    name: "direct",

    async start(opts) {
      agentId = opts.agentId;
      systemPrompt = opts.systemPrompt;
      provider = opts.provider;
      model = opts.model;
      sessionPath = opts.sessionPath
        ? opts.sessionPath.replace(/session\.jsonl$/, "turns.jsonl")
        : null;
      env = opts.env || process.env;
      onEvent = opts.onEvent || (() => {});
      history = sessionPath ? _restore(fs, sessionPath) : [];
      running = true;
      stopped = false;
    },

    updateSystemPrompt(next) {
      systemPrompt = next || "";
    },

    async turn(userTurn) {
      if (stopped) throw new Error("direct harness stopped");
      if (!agentId) throw new Error("direct harness not started");

      onEvent({ kind: "turn_start", data: { harness: "direct", turn: turns + 1 } });

      // Add the user message to history window and truncate.
      const effectiveMessages = [
        ...history,
        { role: "user", content: userTurn },
      ].slice(-MAX_HISTORY_TURNS * 2);

      let raw;
      let usage;
      try {
        const res = await gen({
          provider,
          systemPrompt,
          messages: effectiveMessages,
          model,
          env,
        });
        raw = res.text;
        usage = res.usage;
      } catch (err) {
        onEvent({ kind: "error", data: { where: "provider", message: err?.message || String(err) } });
        throw err;
      }

      const parsed = _parseActions(raw);
      if (parsed.error) {
        onEvent({ kind: "error", data: { where: "parse", raw: raw?.slice?.(0, 400) ?? "", message: parsed.error } });
      }

      // Persist the exchange.
      const userEntry = { ts: Date.now(), role: "user", content: userTurn, harness: "direct" };
      const assistantEntry = {
        ts: Date.now(),
        role: "assistant",
        content: raw ?? "",
        actions: parsed.actions,
        thinking: parsed.thinking,
        usage,
        harness: "direct",
      };
      history.push({ role: "user", content: userTurn });
      history.push({ role: "assistant", content: raw ?? "" });
      // Trim in memory — the JSONL is append-only for history.
      if (history.length > MAX_HISTORY_TURNS * 2) {
        history = history.slice(-MAX_HISTORY_TURNS * 2);
      }
      if (sessionPath) _appendJsonl(fs, sessionPath, userEntry);
      if (sessionPath) _appendJsonl(fs, sessionPath, assistantEntry);

      turns += 1;
      for (const action of parsed.actions) {
        onEvent({ kind: "action", data: action });
      }
      if (parsed.thinking) onEvent({ kind: "think", data: parsed.thinking });
      // Surface usage + counts in turn_end so the Live inspector can
      // tally tokens and tool calls without parsing the JSONL.
      onEvent({
        kind: "turn_end",
        data: {
          harness: "direct",
          turn: turns,
          usage,
          actionCount: parsed.actions.length,
          model,
          provider,
        },
      });

      return {
        actions: parsed.actions,
        thinking: parsed.thinking,
        usage,
        error: parsed.error,
      };
    },

    async stop() {
      stopped = true;
      running = false;
    },

    snapshot() {
      return {
        agentId,
        running,
        turns,
        pending: false,
        extra: {
          provider,
          model,
          historyLen: history.length,
        },
      };
    },
  };

  return harness;
}

// ── helpers ──

function _restore(fs, path) {
  if (!fs.existsSync(path)) return [];
  try {
    const text = fs.readFileSync(path, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.role === "user" || entry.role === "assistant") {
          out.push({ role: entry.role, content: String(entry.content ?? "") });
        }
      } catch { /* skip bad line */ }
    }
    return out.slice(-MAX_HISTORY_TURNS * 2);
  } catch {
    return [];
  }
}

function _appendJsonl(fs, path, entry) {
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`[direct] append ${path} failed:`, err?.message || err);
  }
}

/**
 * Parse a model's raw response into { actions, thinking, error? }.
 * Tolerates whitespace, optional markdown fencing, and extra prose —
 * picks the first balanced {...} block. Invalid entries are dropped
 * with an error field preserved for the inspector.
 *
 * Two input shapes accepted (the parser normalises to the new one):
 *
 *   New (preferred, taught in updated prompts):
 *     {
 *       "thinking": "...",
 *       "actions": [
 *         { "verb": "say", "args": { "text": "hi" } },
 *         { "verb": "move", "args": { "x": 4, "y": 5 } },
 *         { "verb": "post", "args": { "text": "morning, internet" } }
 *       ]
 *     }
 *
 *   Legacy (still emitted by older characters):
 *     { "thinking": "...", "say": "hi", "move": { "x": 4, "y": 5 }, "state": "...", "mood": {...} }
 *
 * Output is always an array of `{ verb, args }` objects in the new
 * shape. The GM's normaliser tolerates both shapes anyway, but the
 * parser emitting the canonical form keeps the inspector + logs clean.
 */
export function _parseActions(raw) {
  const actions = [];
  let thinking;
  if (!raw || typeof raw !== "string") {
    return { actions, thinking, error: "empty response" };
  }
  const json = _extractJson(raw);
  if (!json) return { actions, thinking, error: "no JSON object found" };
  let obj;
  try { obj = JSON.parse(json); } catch (err) {
    return { actions, thinking, error: `JSON parse: ${err?.message || err}` };
  }
  if (typeof obj !== "object" || obj === null) {
    return { actions, thinking, error: "not an object" };
  }
  if (typeof obj.thinking === "string" && obj.thinking.trim()) {
    thinking = obj.thinking.trim();
  }

  // New shape — pass through. Light validation only; the GM enforces
  // schemas. We just keep junk out of the inspector.
  if (Array.isArray(obj.actions)) {
    for (const entry of obj.actions) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.verb !== "string" || entry.verb.trim() === "") continue;
      const args = entry.args && typeof entry.args === "object" && !Array.isArray(entry.args)
        ? entry.args
        : {};
      actions.push({ verb: entry.verb.trim(), args });
    }
    return { actions, thinking };
  }

  // Legacy keyed shape — translate each present key to a {verb,args}.
  if (typeof obj.say === "string" && obj.say.trim()) {
    actions.push({ verb: "say", args: { text: obj.say.trim().slice(0, 1000) } });
  }
  if (obj.move && typeof obj.move === "object") {
    const x = Number(obj.move.x);
    const y = Number(obj.move.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      actions.push({ verb: "move", args: { x: Math.round(x), y: Math.round(y) } });
    }
  }
  if (typeof obj.state === "string" && obj.state.trim()) {
    actions.push({ verb: "set_state", args: { value: obj.state.trim().slice(0, 2000) } });
  }
  if (obj.mood && typeof obj.mood === "object") {
    const args = {};
    const e = obj.mood.energy;
    const s = obj.mood.social;
    if (typeof e === "number" && Number.isFinite(e)) {
      args.energy = Math.max(0, Math.min(100, Math.round(e)));
    }
    if (typeof s === "number" && Number.isFinite(s)) {
      args.social = Math.max(0, Math.min(100, Math.round(s)));
    }
    if (Object.keys(args).length > 0) actions.push({ verb: "set_mood", args });
  }
  return { actions, thinking };
}

function _extractJson(raw) {
  const trimmed = raw.trim();
  // Strip ```json fences if present.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  // Find first balanced {...} block.
  const first = body.indexOf("{");
  if (first === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = first; i < body.length; i++) {
    const ch = body[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return body.slice(first, i + 1);
    }
  }
  return null;
}

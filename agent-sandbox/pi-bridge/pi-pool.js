/**
 * Long-lived pi process pool — one `pi` child per active agent, kept
 * alive across turns. Replaces the previous spawn-per-turn model where
 * every reply paid ~600ms–2s of cold start.
 *
 * Uses pi's RPC mode (`--mode rpc`): the child reads JSON-lines commands
 * on stdin and emits JSON-lines events on stdout. We send
 * `{ type: "prompt", message, id }` to drive a turn and resolve the
 * returned Promise when the matching `agent_end` event arrives.
 *
 * The system prompt is pinned at spawn time, since for a given agent +
 * room it only changes when the character is edited. If `--system-prompt`
 * needs to change, stop + restart the handle (see restartHandle below).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const pool = new Map(); // agentId -> PiHandle

const PI_BIN = process.env.PI_BIN || "pi";

// Crash-loop guard: if pi dies 3 times within this window, stop trying.
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;
// SIGKILL escalation if the child doesn't exit cleanly after SIGTERM.
const SIGKILL_AFTER_MS = 2_000;

class PiHandle {
  constructor({ agentId, provider, model, sessionPath, systemPrompt, env, cwd, onEvent }) {
    this.agentId = agentId;
    this.provider = provider;
    this.model = model;
    this.sessionPath = sessionPath;
    this.systemPrompt = systemPrompt;
    this.env = env;
    this.cwd = cwd;
    this.onEvent = onEvent || (() => {});

    this.child = null;
    this.stdoutRl = null;
    this.stderrRl = null;
    this.stopped = false;
    this.pendingTurn = null;
    this.nextTurnId = 1;
    this.crashes = []; // timestamps of recent exits
    this.lastError = null;
    this.turnCount = 0;
    this.startedAt = 0;
  }

  _spawn() {
    const args = [
      "--provider", this.provider,
      "--model", this.model,
      "--mode", "rpc",
      "--session", this.sessionPath,
      "--system-prompt", this.systemPrompt,
      // The bridge runs its own tool-equivalents via skill scripts that
      // pi invokes through bash. Keeping --no-extensions/--no-skills
      // keeps startup fast and deterministic; built-in read/bash/edit/
      // write/grep/find/ls stay available.
      "--no-extensions",
    ];
    const child = spawn(PI_BIN, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.startedAt = Date.now();
    this.stdoutRl = createInterface({ input: child.stdout });
    this.stdoutRl.on("line", (line) => this._onStdoutLine(line));
    this.stderrRl = createInterface({ input: child.stderr });
    this.stderrRl.on("line", (line) => {
      if (line) console.error(`[pi-pool:${this.agentId}:err] ${line}`);
    });
    child.on("error", (err) => {
      console.error(`[pi-pool:${this.agentId}] spawn error:`, err?.message || err);
      this.lastError = err?.message || String(err);
    });
    child.on("exit", (code, signal) => {
      console.log(`[pi-pool:${this.agentId}] exited code=${code} signal=${signal}`);
      this._onExit(code);
    });
    this.onEvent({ kind: "pool:spawn", pid: child.pid });
  }

  _onStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev;
    try { ev = JSON.parse(trimmed); } catch {
      // Non-JSON stdout (shouldn't happen in rpc mode) — log as-is.
      this.onEvent({ kind: "stdout", text: trimmed });
      return;
    }
    this.onEvent({ kind: "pi", data: ev });

    const turn = this.pendingTurn;
    if (!turn) return;

    // Prompt failure (bad API key, context-too-large, etc).
    if (ev.type === "response" && ev.command === "prompt" && ev.id === turn.id && ev.success === false) {
      this.pendingTurn = null;
      const err = new Error(ev.error || "pi prompt failed");
      turn.reject(err);
      return;
    }
    // Capture the final assistant message before agent_end arrives.
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      turn.finalMessage = ev.message;
    }
    // End-of-turn signal.
    if (ev.type === "agent_end") {
      this.pendingTurn = null;
      this.turnCount++;
      turn.resolve({
        message: turn.finalMessage,
        messages: ev.messages,
      });
    }
  }

  _onExit(code) {
    this.child = null;
    try { this.stdoutRl?.close(); } catch {}
    try { this.stderrRl?.close(); } catch {}
    if (this.pendingTurn) {
      this.pendingTurn.reject(new Error(`pi exited mid-turn (code=${code})`));
      this.pendingTurn = null;
    }
    this.onEvent({ kind: "pool:exit", code });
    if (this.stopped) return;

    // Crash-loop guard — slide a 1-minute window of recent deaths.
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashes.push(now);
    if (this.crashes.length >= MAX_CRASHES) {
      console.error(`[pi-pool:${this.agentId}] ${MAX_CRASHES} crashes in ${CRASH_WINDOW_MS/1000}s, giving up`);
      this.stopped = true;
      this.onEvent({ kind: "pool:crashed", reason: "crash-loop" });
      pool.delete(this.agentId);
      return;
    }
    // Small backoff — a quota error from a provider will otherwise
    // hot-spin the respawn.
    setTimeout(() => {
      if (!this.stopped) this._spawn();
    }, 500);
  }

  turn(userMessage) {
    if (this.stopped) return Promise.reject(new Error("pi handle stopped"));
    if (!this.child) return Promise.reject(new Error("pi not running"));
    if (this.pendingTurn) return Promise.reject(new Error("turn in progress"));
    const id = `t${this.nextTurnId++}`;
    return new Promise((resolve, reject) => {
      this.pendingTurn = { id, resolve, reject, finalMessage: null };
      try {
        this.child.stdin.write(JSON.stringify({ type: "prompt", message: userMessage, id }) + "\n");
      } catch (err) {
        this.pendingTurn = null;
        reject(err);
      }
    });
  }

  stop() {
    this.stopped = true;
    if (!this.child) return;
    try { this.child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      if (this.child) {
        try { this.child.kill("SIGKILL"); } catch {}
      }
    }, SIGKILL_AFTER_MS).unref();
  }

  snapshot() {
    return {
      agentId: this.agentId,
      running: !!this.child,
      pid: this.child?.pid ?? null,
      turns: this.turnCount,
      pending: !!this.pendingTurn,
      crashes: this.crashes.length,
      lastError: this.lastError,
      startedAt: this.startedAt || null,
    };
  }
}

export function startPi(opts) {
  if (pool.has(opts.agentId)) throw new Error(`pi already running for agent ${opts.agentId}`);
  const handle = new PiHandle(opts);
  pool.set(opts.agentId, handle);
  handle._spawn();
  return handle;
}

export function getPi(agentId) {
  return pool.get(agentId) ?? null;
}

export function stopPi(agentId) {
  const handle = pool.get(agentId);
  if (!handle) return false;
  handle.stop();
  pool.delete(agentId);
  return true;
}

/**
 * Tear down and respawn a handle, typically because the system prompt
 * changed (character about/state edited). The session file persists
 * so pi resumes its conversation history naturally.
 */
export function restartHandle(agentId, patch = {}) {
  const existing = pool.get(agentId);
  if (!existing) return null;
  const opts = {
    agentId,
    provider: patch.provider ?? existing.provider,
    model: patch.model ?? existing.model,
    sessionPath: existing.sessionPath,
    systemPrompt: patch.systemPrompt ?? existing.systemPrompt,
    env: existing.env,
    cwd: existing.cwd,
    onEvent: existing.onEvent,
  };
  stopPi(agentId);
  return startPi(opts);
}

export function poolSnapshot() {
  return [...pool.values()].map((h) => h.snapshot());
}

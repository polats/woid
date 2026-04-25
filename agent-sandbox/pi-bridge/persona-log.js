/**
 * Append-only JSONL log of public persona-API generations.
 *
 * One file: `$WORKSPACE/persona-log.jsonl`. Rotates when it crosses
 * MAX_BYTES — current file is renamed to `persona-log.<ts>.jsonl` and
 * a fresh one starts. Reads only scan the current file (rotated
 * archives stay on disk for forensics but aren't surfaced via the API).
 *
 * Records are intentionally small. Seeds are hashed, not stored verbatim.
 */

import { appendFileSync, readFileSync, existsSync, statSync, renameSync } from "fs";
import { join } from "path";
import crypto from "crypto";

const MAX_BYTES = 5_000_000; // ~5MB before rotation

let logPath = null;

export function init(workspace) {
  logPath = join(workspace, "persona-log.jsonl");
}

function maybeRotate() {
  if (!logPath || !existsSync(logPath)) return;
  try {
    const { size } = statSync(logPath);
    if (size > MAX_BYTES) {
      renameSync(logPath, `${logPath}.${Date.now()}`);
    }
  } catch { /* ignore */ }
}

export function hashSeed(seed) {
  if (!seed) return null;
  return crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 16);
}

export function newId() {
  return `pg_${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Append a record. Caller passes the public fields; we add ts.
 * Returns the stored record (with ts).
 */
export function append(record) {
  if (!logPath) return record;
  maybeRotate();
  const row = { ts: Date.now(), ...record };
  try {
    appendFileSync(logPath, JSON.stringify(row) + "\n");
  } catch (err) {
    console.warn("[persona-log] append failed:", err.message);
  }
  return row;
}

function readAll() {
  if (!logPath || !existsSync(logPath)) return [];
  const text = readFileSync(logPath, "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/** Newest first. `redact` strips the `about` field from rows. */
export function list({ limit = 50, cursor = 0, redactAbout = false } = {}) {
  const all = readAll().reverse();
  const start = Math.max(0, Number(cursor) | 0);
  const slice = all.slice(start, start + Math.max(1, Math.min(200, limit | 0)));
  return {
    total: all.length,
    nextCursor: start + slice.length < all.length ? start + slice.length : null,
    items: slice.map((r) => redactAbout ? omit(r, ["about"]) : r),
  };
}

export function getById(id) {
  return readAll().find((r) => r.id === id) ?? null;
}

/** For /v1/personas/status: 24h success/failure counts and median duration. */
export function recentStats(windowMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  const recent = readAll().filter((r) => r.ts >= cutoff);
  const ok = recent.filter((r) => r.ok);
  const fail = recent.length - ok.length;
  const durations = ok.map((r) => r.durationMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const p50 = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  return { ok24h: ok.length, fail24h: fail, p50ms: p50 };
}

function omit(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

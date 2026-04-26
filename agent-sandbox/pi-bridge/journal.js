/**
 * Scene journal — append-only log of every scene that's occurred,
 * stored as JSONL (one record per closed scene).
 *
 * Lifecycle, mirroring the scene tracker:
 *
 *   openScene(...)   ← called when scene_tracker emits an opened event
 *   appendTurn(...)  ← called for every action committed by a
 *                       participant while the scene is open
 *   closeScene(...)  ← called when scene_tracker emits a closed event
 *
 * On close, the in-memory record is finalised (ts_end, end_reason)
 * and written as a single JSONL line to `<workspace>/scenes.jsonl`.
 * The in-memory entry is then dropped — only closed scenes persist.
 *
 * If the bridge crashes mid-scene, the in-flight record is lost.
 * That's intentional for MVP — the scene tracker also resets on
 * restart, so a partially-recorded scene would be orphaned anyway.
 *
 * Storage stays JSONL until #215's SQLite migration; this module's
 * read-back path scans the file and parses each line. Fine at our
 * scale (a few thousand scenes); promotable when needed.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAME = "scenes.jsonl";

/**
 * @param {{
 *   workspacePath: string,
 *   fs?: { mkdirSync, appendFileSync, existsSync, readFileSync },
 *   now?: () => number,
 * }} opts
 */
export function createJournal({ workspacePath, fs, now } = {}) {
  if (!workspacePath) throw new Error("createJournal: workspacePath required");
  const fsImpl = fs ?? { mkdirSync, appendFileSync, existsSync, readFileSync };
  const nowFn = now ?? (() => Date.now());
  const path = join(workspacePath, FILE_NAME);

  /** @type {Map<string, object>} sceneId → in-progress record */
  const open = new Map();

  function openScene({ sceneId, participants, startedAt, budget }) {
    if (!sceneId || !Array.isArray(participants) || participants.length < 2) return;
    if (open.has(sceneId)) return; // idempotent
    open.set(sceneId, {
      scene_id: sceneId,
      ts_start: startedAt ?? nowFn(),
      ts_end: null,
      participants: [...participants],
      budget: budget ?? null,
      end_reason: null,
      turns: [],
    });
  }

  function appendTurn(sceneId, turn) {
    const rec = open.get(sceneId);
    if (!rec) return;
    if (!turn || typeof turn.verb !== "string") return;
    rec.turns.push({
      ts: turn.ts ?? nowFn(),
      actor_pubkey: turn.actor_pubkey ?? null,
      actor_name: turn.actor_name ?? null,
      verb: turn.verb,
      args: turn.args ?? {},
    });
  }

  /**
   * Append the same turn entry to every currently-open scene
   * containing `actorPubkey`. Convenient for the bridge's commit
   * path — one call covers an actor in N overlapping scenes (rare
   * for a 2-person room but useful in trios).
   */
  function appendTurnForActor(actorPubkey, turn) {
    for (const rec of open.values()) {
      if (rec.participants.includes(actorPubkey)) {
        appendTurn(rec.scene_id, turn);
      }
    }
  }

  function closeScene({ sceneId, endedAt, endReason }) {
    const rec = open.get(sceneId);
    if (!rec) return null;
    open.delete(sceneId);
    rec.ts_end = endedAt ?? nowFn();
    rec.end_reason = endReason ?? "unknown";
    try {
      fsImpl.mkdirSync(dirname(path), { recursive: true });
      fsImpl.appendFileSync(path, JSON.stringify(rec) + "\n");
    } catch (err) {
      console.error(`[journal] failed to write ${path}:`, err?.message || err);
    }
    return rec;
  }

  /**
   * Read all closed scenes back from disk. Filters and pagination
   * happen in-memory after the parse — fine at MVP scale; revisit
   * with #215's SQLite migration.
   *
   * @param {{ limit?: number, before?: number, participant?: string }} [opts]
   */
  function listScenes(opts = {}) {
    const all = readAll();
    let filtered = all;
    if (opts.participant) {
      filtered = filtered.filter((s) => s.participants?.includes(opts.participant));
    }
    if (typeof opts.before === "number") {
      filtered = filtered.filter((s) => (s.ts_start ?? 0) < opts.before);
    }
    // newest first
    filtered.sort((a, b) => (b.ts_end ?? b.ts_start ?? 0) - (a.ts_end ?? a.ts_start ?? 0));
    if (typeof opts.limit === "number" && opts.limit > 0) {
      filtered = filtered.slice(0, opts.limit);
    }
    return filtered;
  }

  function getScene(sceneId) {
    if (open.has(sceneId)) return open.get(sceneId);
    return readAll().find((s) => s.scene_id === sceneId) ?? null;
  }

  /**
   * Return the most recent CLOSED scenes that included both pubkeys.
   * Newest-first. Used by slice 7's memory injection — when characters
   * re-encounter, the LLM reads its own past dialogue verbatim.
   *
   * @param {string} pubkeyA
   * @param {string} pubkeyB
   * @param {{ limit?: number }} [opts]
   * @returns {Array<object>}
   */
  function recentScenesBetween(pubkeyA, pubkeyB, opts = {}) {
    if (!pubkeyA || !pubkeyB || pubkeyA === pubkeyB) return [];
    const all = readAll();
    const between = all.filter((s) =>
      Array.isArray(s.participants) &&
      s.participants.includes(pubkeyA) &&
      s.participants.includes(pubkeyB),
    );
    between.sort((a, b) => (b.ts_end ?? b.ts_start ?? 0) - (a.ts_end ?? a.ts_start ?? 0));
    if (typeof opts.limit === "number" && opts.limit > 0) {
      return between.slice(0, opts.limit);
    }
    return between;
  }

  /** Snapshot of currently-open (in-flight) scenes. */
  function openSnapshot() {
    return [...open.values()].map((s) => ({
      scene_id: s.scene_id,
      participants: s.participants,
      ts_start: s.ts_start,
      turn_count: s.turns.length,
    }));
  }

  function clearOpen() {
    open.clear();
  }

  function readAll() {
    if (!fsImpl.existsSync(path)) return [];
    let text;
    try { text = fsImpl.readFileSync(path, "utf-8"); }
    catch { return []; }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); }
      catch { /* skip malformed */ }
    }
    return out;
  }

  return {
    openScene,
    appendTurn,
    appendTurnForActor,
    closeScene,
    listScenes,
    getScene,
    recentScenesBetween,
    openSnapshot,
    clearOpen,
    /** internal — exposed for tests */
    _path: path,
  };
}

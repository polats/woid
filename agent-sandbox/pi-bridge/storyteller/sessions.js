/**
 * Sessions — one record per sim-day, the bookend of the storyteller's
 * engagement loop.
 *
 *   on boot              → ensure a session is open for today's sim-day
 *   on sim-day rollover  → finalize today's session, write JSONL,
 *                          generate the recap, open tomorrow's
 *
 * Each session captures the day's "perception window" — the typed log
 * of events worth recapping (scene closes, moodlets emitted, position
 * deltas, departures). The recap LLM call (#275 slice 2.2) reads this
 * window to write a 100-150 word past-tense summary the user opens
 * the app to read.
 *
 * Storage: JSONL at $WORKSPACE/sessions/sessions.jsonl, one row per
 * closed session. The currently-open session lives in-memory only —
 * persisted to a sidecar `current.json` so a bridge crash mid-day
 * doesn't lose the partial window.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DIR_NAME = "sessions";
const FILE_NAME = "sessions.jsonl";
const CURRENT_FILE = "current.json";

/**
 * @param {{
 *   workspacePath: string,
 *   simClock: { now: Function, simDay: Function, nextDayRolloverRealMs: Function },
 *   fs?: typeof FS_DEFAULT,
 *   id?: () => string,
 *   onClose?: (session) => Promise<void> | void,
 * }} opts
 */
export function createSessionStore(opts = {}) {
  if (!opts.workspacePath) throw new Error("createSessionStore: workspacePath required");
  if (!opts.simClock) throw new Error("createSessionStore: simClock required");
  const fsImpl = opts.fs ?? { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync };
  const idFn = opts.id ?? (() => `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const dirPath = join(opts.workspacePath, DIR_NAME);
  const jsonlPath = join(dirPath, FILE_NAME);
  const currentPath = join(dirPath, CURRENT_FILE);

  /** Currently-open session (in memory + sidecar). */
  let current = null;

  loadCurrent();

  function loadCurrent() {
    if (!fsImpl.existsSync(currentPath)) return;
    try {
      const data = JSON.parse(fsImpl.readFileSync(currentPath, "utf-8"));
      if (data?.id && Number.isFinite(data?.sim_day)) {
        current = data;
      }
    } catch { /* ignore */ }
  }

  function persistCurrent() {
    try {
      fsImpl.mkdirSync(dirname(currentPath), { recursive: true });
      fsImpl.writeFileSync(currentPath, JSON.stringify(current, null, 2));
    } catch (err) {
      console.error(`[sessions] persist current failed:`, err?.message || err);
    }
  }

  function clearCurrent() {
    try {
      // Truncate rather than unlink — keeps the file present for
      // observability tools that expect it.
      fsImpl.writeFileSync(currentPath, "{}");
    } catch { /* ignore */ }
  }

  function persistClosed(rec) {
    try {
      fsImpl.mkdirSync(dirname(jsonlPath), { recursive: true });
      fsImpl.appendFileSync(jsonlPath, JSON.stringify(rec) + "\n");
    } catch (err) {
      console.error(`[sessions] persist closed failed:`, err?.message || err);
    }
  }

  /**
   * Ensure a session is open for the current sim-day. Idempotent —
   * if one is already open and matches, returns it; if a stale one
   * is open (sim-day has advanced), closes it first.
   */
  async function ensureOpen() {
    const snap = opts.simClock.now();
    if (current && current.sim_day === snap.sim_day) return current;
    if (current) await closeCurrent({ reason: "rollover" });
    return openNew(snap);
  }

  function openNew(snap) {
    const sim = snap || opts.simClock.now();
    current = {
      id: idFn(),
      sim_day: sim.sim_day,
      opened_at: sim.real_ms,
      sim_iso_open: sim.sim_iso,
      closed_at: null,
      sim_iso_close: null,
      end_reason: null,
      events: [],   // perception window worth recapping
      recap: null,  // filled by recap LLM call at close
    };
    persistCurrent();
    return current;
  }

  /**
   * Append an event to the current session's window. Cheap — rate-
   * limited callers should pre-filter (only |weight|≥5 moodlets, only
   * scene closes, etc.).
   */
  function appendEvent(event) {
    if (!current) return;
    if (!event || typeof event.kind !== "string") return;
    current.events.push({ ts: event.ts ?? Date.now(), ...event });
    persistCurrent();
  }

  /**
   * Close the current session, run the optional onClose hook (the
   * recap LLM call wires here), persist as JSONL, clear the sidecar.
   */
  async function closeCurrent({ reason = "rollover" } = {}) {
    if (!current) return null;
    const closing = current;
    const snap = opts.simClock.now();
    closing.closed_at = snap.real_ms;
    closing.sim_iso_close = snap.sim_iso;
    closing.end_reason = reason;
    if (typeof opts.onClose === "function") {
      try { await opts.onClose(closing); }
      catch (err) { console.warn("[sessions] onClose hook failed:", err?.message || err); }
    }
    persistClosed(closing);
    current = null;
    clearCurrent();
    return closing;
  }

  /**
   * Read every persisted (closed) session from disk. Newest first.
   */
  function listClosed({ limit } = {}) {
    if (!fsImpl.existsSync(jsonlPath)) return [];
    let text = "";
    try { text = fsImpl.readFileSync(jsonlPath, "utf-8"); }
    catch { return []; }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.id) out.push(rec);
      } catch { /* skip */ }
    }
    out.sort((a, b) => (b.sim_day ?? 0) - (a.sim_day ?? 0));
    return typeof limit === "number" ? out.slice(0, limit) : out;
  }

  function getById(id) {
    if (current?.id === id) return current;
    return listClosed().find((r) => r.id === id) ?? null;
  }

  function getBySimDay(simDay) {
    if (current?.sim_day === simDay) return current;
    return listClosed().find((r) => r.sim_day === simDay) ?? null;
  }

  function snapshot() {
    return {
      current: current ? { id: current.id, sim_day: current.sim_day, sim_iso_open: current.sim_iso_open, opened_at: current.opened_at, event_count: current.events.length } : null,
      closed_count: countClosed(),
    };
  }

  function countClosed() {
    if (!fsImpl.existsSync(jsonlPath)) return 0;
    try {
      const text = fsImpl.readFileSync(jsonlPath, "utf-8");
      return text.split("\n").filter((l) => l.trim()).length;
    } catch { return 0; }
  }

  return {
    ensureOpen, closeCurrent, appendEvent,
    listClosed, getById, getBySimDay,
    snapshot,
    /** internal — current session reference */
    current: () => current,
  };
}

/**
 * Relationships store — per-pair record of who's met whom.
 *
 * Slice 1 of #365. Backs the first-meeting detection that powers the
 * Maya-meets-Roman scenario (docs/design/scenarios/maya-meets-roman.md).
 * Future slices add weight, friendship-state-machine, sentiment.
 *
 * Key shape: ordered pair `<a>|<b>` where a < b lexicographically.
 * One record per pair, append-on-create, mutate in place via writeFile
 * snapshots (no JSONL log — pair count stays small for the scenarios
 * we're building. Promote to JSONL/SQLite when the cast outgrows
 * O(N²)).
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAME = "relationships.json";

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * @param {{
 *   workspacePath: string,
 *   fs?: { mkdirSync, existsSync, readFileSync, writeFileSync },
 *   now?: () => number,
 * }} opts
 */
export function createRelationships(opts = {}) {
  if (!opts.workspacePath) throw new Error("createRelationships: workspacePath required");
  const fsImpl = opts.fs ?? { mkdirSync, existsSync, readFileSync, writeFileSync };
  const nowFn = opts.now ?? (() => Date.now());
  const path = join(opts.workspacePath, FILE_NAME);

  /** @type {Map<string, object>} pairKey → record */
  const records = new Map();

  loadFromDisk();

  function loadFromDisk() {
    if (!fsImpl.existsSync(path)) return;
    try {
      const data = JSON.parse(fsImpl.readFileSync(path, "utf-8"));
      if (Array.isArray(data?.records)) {
        for (const r of data.records) {
          if (r?.pair) records.set(r.pair, r);
        }
      }
    } catch (err) {
      console.error(`[relationships] load ${path} failed:`, err?.message || err);
    }
  }

  function persist() {
    try {
      fsImpl.mkdirSync(dirname(path), { recursive: true });
      fsImpl.writeFileSync(
        path,
        JSON.stringify({ records: [...records.values()] }, null, 2),
      );
    } catch (err) {
      console.error(`[relationships] persist ${path} failed:`, err?.message || err);
    }
  }

  /**
   * If this is the first encounter between a and b, create a record
   * and return `{ created: true, record }`. Otherwise bump
   * scenes_count + last_seen_at and return `{ created: false, record }`.
   *
   * @param {string} a pubkey
   * @param {string} b pubkey
   * @param {{ sim_iso?: string, sim_day?: number }} [extra]
   */
  function recordEncounter(a, b, extra = {}) {
    if (!a || !b || a === b) return { created: false, record: null };
    const key = pairKey(a, b);
    const now = nowFn();
    const existing = records.get(key);
    if (existing) {
      existing.scenes_count = (existing.scenes_count || 0) + 1;
      existing.last_seen_at = now;
      if (extra.sim_iso) existing.last_seen_sim_iso = extra.sim_iso;
      persist();
      return { created: false, record: existing };
    }
    const [from, to] = a < b ? [a, b] : [b, a];
    const rec = {
      pair: key,
      from_pubkey: from,
      to_pubkey: to,
      met_at_real_ms: now,
      met_at_sim_iso: extra.sim_iso ?? null,
      met_at_sim_day: extra.sim_day ?? null,
      scenes_count: 1,
      last_seen_at: now,
      last_seen_sim_iso: extra.sim_iso ?? null,
    };
    records.set(key, rec);
    persist();
    return { created: true, record: rec };
  }

  function get(a, b) {
    if (!a || !b || a === b) return null;
    return records.get(pairKey(a, b)) ?? null;
  }

  function listFor(pubkey) {
    if (!pubkey) return [];
    const out = [];
    for (const r of records.values()) {
      if (r.from_pubkey === pubkey || r.to_pubkey === pubkey) out.push(r);
    }
    return out;
  }

  function listAll() {
    return [...records.values()];
  }

  function snapshot() {
    return { count: records.size, pairs: listAll() };
  }

  return {
    recordEncounter, get, listFor, listAll, snapshot,
    _path: path,
  };
}

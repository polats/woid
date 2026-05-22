/**
 * Node `fs`-backed persistence for createMoodletsTracker.
 *
 * Matches the `{ load, save }` interface declared by woid-core/harness/moodlets.js.
 * Storage shape: one append-only JSONL file per key under
 * `<workspacePath>/<dirName>/<key>.jsonl`.
 *
 * Extracted from agent-sandbox/pi-bridge/moodlets.js so pi-bridge (Node)
 * and the browser (in-memory or localStorage) can both consume the same
 * core tracker.
 */

import {
  mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";

/**
 * @param {{
 *   workspacePath: string,
 *   dirName?: string,
 *   fs?: { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync },
 * }} opts
 * @returns {{ load: () => Map<string, object[]>, save: (key: string, bucket: object[]) => void, _dir: string }}
 */
export function createFsPersist(opts = {}) {
  if (!opts.workspacePath) throw new Error("createFsPersist: workspacePath required");
  const fsImpl = opts.fs ?? { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync };
  const dirName = opts.dirName ?? "moodlets";
  const dirPath = join(opts.workspacePath, dirName);

  function fileFor(key) {
    return join(dirPath, `${key}.jsonl`);
  }

  function load() {
    /** @type {Map<string, object[]>} */
    const out = new Map();
    if (!fsImpl.existsSync(dirPath)) return out;
    let entries;
    try { entries = fsImpl.readdirSync(dirPath); }
    catch { return out; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const key = name.slice(0, -".jsonl".length);
      const filePath = join(dirPath, name);
      let text;
      try { text = fsImpl.readFileSync(filePath, "utf-8"); }
      catch { continue; }
      const bucket = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m?.id && m?.tag) bucket.push(m);
        } catch { /* skip malformed */ }
      }
      if (bucket.length > 0) out.set(key, bucket);
    }
    return out;
  }

  function save(key, bucket) {
    const filePath = fileFor(key);
    try {
      fsImpl.mkdirSync(dirname(filePath), { recursive: true });
      const lines = (bucket ?? []).map((m) => JSON.stringify(m));
      fsImpl.writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""));
    } catch (err) {
      console.error(`[moodlets] persist ${filePath} failed:`, err?.message || err);
    }
  }

  return { load, save, _dir: dirPath };
}

/**
 * Back-compat wrapper. The canonical moodlets tracker now lives in
 * woid-core/harness/moodlets.js. This shim preserves pi-bridge's
 * (workspacePath, fs?) constructor by building an fs-backed persist
 * adapter and passing it through.
 *
 * All other exports (bandFor, describeMood, seedDemoMoodlets, MOOD_BANDS, etc.)
 * re-export verbatim.
 */

import { createMoodletsTracker as _createTracker } from "../woid-core/harness/moodlets.js";
import { createFsPersist } from "../woid-core/harness/moodlets/persist-fs.js";

export {
  MOOD_BANDS,
  bandFor,
  describeMood,
  seedDemoMoodlets,
} from "../woid-core/harness/moodlets.js";

/**
 * Pi-bridge's call-site signature: `{ workspacePath, fs?, now?, id?, baseline?, defaultDurationMs? }`.
 * Internally wires an fs persist adapter and delegates to the canonical
 * factory. Returned tracker keeps the legacy `_dir` field pointing at
 * the JSONL directory for callers (e.g. compactor) that need it.
 *
 * @param {{
 *   workspacePath: string,
 *   fs?: { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync },
 *   now?: () => number,
 *   id?: () => string,
 *   baseline?: number,
 *   defaultDurationMs?: number,
 * }} opts
 */
export function createMoodletsTracker(opts = {}) {
  if (!opts.workspacePath) throw new Error("createMoodletsTracker: workspacePath required");
  const persist = createFsPersist({ workspacePath: opts.workspacePath, fs: opts.fs });
  const tracker = _createTracker({
    persist,
    now: opts.now,
    id: opts.id,
    baseline: opts.baseline,
    defaultDurationMs: opts.defaultDurationMs,
  });
  // Preserve legacy field for callers that need the on-disk directory.
  return { ...tracker, _dir: persist._dir };
}

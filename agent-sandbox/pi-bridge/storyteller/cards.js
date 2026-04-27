/**
 * Card loader — slice 1 of #305.
 *
 * Cards live as JSON files under `cards/**\/*.json`. Each card declares
 * metadata (id, phase, weight, intensity window, cooldown), a trigger
 * predicate, role bindings, and an ordered action list. The director
 * (slice 3) selects from eligible cards; the action runtime (slice 2)
 * executes the action list in order against the bridge's verbs +
 * narrative-state surfaces.
 *
 * Design choices:
 *   - JSON, not YAML/markdown. We avoid a YAML dep; cards are
 *     structured config, not narrative prose. Designers can still
 *     embed a `description` field for human flavor text. (#305 slice
 *     5+ may add markdown wrappers; this is the foundation.)
 *   - Validation up-front. Cards with a malformed schema log a
 *     warning and are skipped — never quietly accepted with bad
 *     fields, which would surface as runtime crashes during card
 *     selection.
 *   - Hot reload in dev. `loadAll()` re-reads from disk; the bridge
 *     can call it on a file-watcher signal or a debug endpoint.
 *
 * Schema (JSON):
 *   {
 *     "id": string (required, unique),
 *     "phase": "cold_open" | "opening" | "ambient" | "closing" | "cliffhanger",
 *     "weight": number (default 1),
 *     "intensity_min": number 0..1 (default 0),
 *     "intensity_max": number 0..1 (default 1),
 *     "once_per_session": boolean (default false),
 *     "exhaustible": boolean (default false),
 *     "cooldown_sim_min": number (default 0),
 *     "trigger": { "any"?: string[], "all"?: string[], "none"?: string[] },
 *     "roles": { [roleName]: { "select": "random_character" | string } },
 *     "actions": [ { "type": string, ...args } ],
 *     "description": string (optional, prompt + UI flavor)
 *   }
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

export const VALID_PHASES = new Set(["cold_open", "opening", "ambient", "closing", "cliffhanger"]);

/**
 * @param {{
 *   cardsPath: string,
 *   fs?: { existsSync, readdirSync, readFileSync, statSync },
 * }} opts
 */
export function createCardLoader(opts = {}) {
  if (!opts.cardsPath) throw new Error("createCardLoader: cardsPath required");
  const fsImpl = opts.fs ?? { existsSync, readdirSync, readFileSync, statSync };
  const root = opts.cardsPath;

  /** @type {Map<string, object>} id → card */
  const cards = new Map();
  /** @type {Array<{ file: string, error: string }>} */
  let lastErrors = [];

  function walk(dir) {
    if (!fsImpl.existsSync(dir)) return [];
    const out = [];
    for (const entry of fsImpl.readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = fsImpl.statSync(full);
      if (st.isDirectory()) {
        out.push(...walk(full));
      } else if (extname(entry) === ".json") {
        out.push(full);
      }
    }
    return out;
  }

  /**
   * Load (or reload) every card from disk. Returns
   * `{ loaded, errors }` so callers can surface load problems.
   */
  function loadAll() {
    cards.clear();
    lastErrors = [];
    const files = walk(root);
    for (const file of files) {
      let parsed;
      try {
        parsed = JSON.parse(fsImpl.readFileSync(file, "utf-8"));
      } catch (err) {
        lastErrors.push({ file, error: `JSON parse: ${err.message}` });
        continue;
      }
      const validation = validateCard(parsed, file);
      if (!validation.ok) {
        lastErrors.push({ file, error: validation.reason });
        continue;
      }
      const card = normaliseCard(parsed);
      if (cards.has(card.id)) {
        lastErrors.push({ file, error: `duplicate card id "${card.id}" (already loaded from another file)` });
        continue;
      }
      cards.set(card.id, card);
    }
    return { loaded: cards.size, errors: lastErrors.slice(), files: files.length };
  }

  function get(id) { return cards.get(id) ?? null; }
  function listAll() { return [...cards.values()]; }
  function listByPhase(phase) {
    return [...cards.values()].filter((c) => c.phase === phase);
  }
  function snapshot() {
    return {
      count: cards.size,
      byPhase: Object.fromEntries(
        ["cold_open", "opening", "ambient", "closing", "cliffhanger"].map((p) => [p, listByPhase(p).length]),
      ),
      errors: lastErrors.slice(),
    };
  }

  return { loadAll, get, listAll, listByPhase, snapshot };
}

// ── validation + normalisation ──

const VALID_ACTION_TYPES = new Set([
  "EmitMoodlet",
  "ClearMoodletByTag",
  "Suggest",
  "Notice",
  "ModifyRel",
  "SetData",
  "CheckData",
  "TriggerCard",
  "Wait",
  "RNG",
  "Label",
  "GoTo",
  "SpawnAction",
  "DespawnTag",
]);

export function validateCard(c, file = "<inline>") {
  if (!c || typeof c !== "object") return { ok: false, reason: "card must be a JSON object" };
  if (typeof c.id !== "string" || !c.id.trim()) return { ok: false, reason: `${file}: missing or empty "id"` };
  if (typeof c.phase !== "string" || !VALID_PHASES.has(c.phase)) {
    return { ok: false, reason: `${file}: phase must be one of ${[...VALID_PHASES].join("/")}` };
  }
  if (c.weight !== undefined && typeof c.weight !== "number") {
    return { ok: false, reason: `${file}: weight must be a number` };
  }
  for (const k of ["intensity_min", "intensity_max", "cooldown_sim_min"]) {
    if (c[k] !== undefined && typeof c[k] !== "number") {
      return { ok: false, reason: `${file}: ${k} must be a number` };
    }
  }
  if (!Array.isArray(c.actions) || c.actions.length === 0) {
    return { ok: false, reason: `${file}: actions[] must be a non-empty array` };
  }
  for (let i = 0; i < c.actions.length; i++) {
    const a = c.actions[i];
    if (!a || typeof a !== "object") return { ok: false, reason: `${file}: actions[${i}] must be an object` };
    if (typeof a.type !== "string" || !VALID_ACTION_TYPES.has(a.type)) {
      return { ok: false, reason: `${file}: actions[${i}].type "${a.type}" is not a known action; expected one of ${[...VALID_ACTION_TYPES].join(", ")}` };
    }
  }
  if (c.trigger && typeof c.trigger !== "object") {
    return { ok: false, reason: `${file}: trigger must be an object` };
  }
  if (c.trigger) {
    for (const k of ["any", "all", "none"]) {
      if (c.trigger[k] === undefined) continue;
      if (!Array.isArray(c.trigger[k])) return { ok: false, reason: `${file}: trigger.${k} must be an array` };
      for (let i = 0; i < c.trigger[k].length; i++) {
        if (typeof c.trigger[k][i] !== "string") return { ok: false, reason: `${file}: trigger.${k}[${i}] must be a string` };
      }
    }
  }
  if (c.roles && typeof c.roles !== "object") {
    return { ok: false, reason: `${file}: roles must be an object` };
  }
  // Validate Label/GoTo wiring at load time so a card can't ship with
  // a dangling GoTo target.
  const labels = new Set(c.actions.filter((a) => a.type === "Label").map((a) => a.name));
  for (const a of c.actions) {
    if (a.type === "GoTo") {
      if (typeof a.target !== "string" || !labels.has(a.target)) {
        return { ok: false, reason: `${file}: GoTo target "${a.target}" has no matching Label` };
      }
    }
  }
  return { ok: true };
}

function normaliseCard(c) {
  return {
    id: c.id,
    phase: c.phase,
    weight: typeof c.weight === "number" ? c.weight : 1,
    intensity_min: clamp01(c.intensity_min ?? 0),
    intensity_max: clamp01(c.intensity_max ?? 1),
    once_per_session: c.once_per_session === true,
    exhaustible: c.exhaustible === true,
    cooldown_sim_min: typeof c.cooldown_sim_min === "number" ? c.cooldown_sim_min : 0,
    trigger: c.trigger ?? {},
    roles: c.roles ?? {},
    actions: c.actions.slice(),
    description: typeof c.description === "string" ? c.description : "",
  };
}

function clamp01(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

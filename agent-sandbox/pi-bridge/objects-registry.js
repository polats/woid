/**
 * Object instance registry — tracks live placed objects, their
 * positions, and per-instance mutable state. Persisted as JSONL
 * under $WORKSPACE/objects.jsonl (#215 will promote to SQLite later).
 *
 * Slice 1 of #245 covers placement, listing, persistence, and a
 * proximity-filtered "what's nearby" query the perception block
 * uses. Slice 2 adds the `use(object_id)` verb + capacity / effects
 * wired through the GM.
 *
 * Instances have:
 *   id        — generated short id, stable across restarts
 *   type      — string from OBJECT_TYPES
 *   x, y      — tile coords on the room grid
 *   state     — mutable per-instance fields (defaults from the type)
 *   createdAt — for ordering / debugging
 *
 * Spatial: a flat Array.filter scan handles <500 objects at woid's
 * scale. The card calls out a grid hash if/when we measure a problem.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { OBJECT_TYPES, getType } from "./objects.js";

const FILE_NAME = "objects.jsonl";

/**
 * @param {{
 *   workspacePath: string,
 *   fs?: { mkdirSync, existsSync, readFileSync, writeFileSync },
 *   now?: () => number,
 *   id?: () => string,
 * }} opts
 */
export function createObjectsRegistry({ workspacePath, fs, now, id } = {}) {
  if (!workspacePath) throw new Error("createObjectsRegistry: workspacePath required");
  const fsImpl = fs ?? { mkdirSync, existsSync, readFileSync, writeFileSync };
  const nowFn = now ?? (() => Date.now());
  const idFn = id ?? (() => `obj_${randomUUID().slice(0, 8)}`);
  const path = join(workspacePath, FILE_NAME);

  /** @type {Map<string, object>} id → instance */
  const instances = new Map();

  // Hydrate on construction. JSONL: one snapshot per line, last
  // line wins for any given id. Cheap and crash-tolerant; the next
  // mutating call rewrites the whole file in place.
  loadFromDisk();

  function placeOne({ type, x, y, state }) {
    const def = getType(type);
    if (!def) throw new Error(`unknown object type "${type}"`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("placeOne: x and y must be finite numbers");
    }
    const inst = {
      id: idFn(),
      type,
      x: Math.round(x),
      y: Math.round(y),
      state: { ...(def.defaultState || {}), ...(state || {}) },
      createdAt: nowFn(),
    };
    instances.set(inst.id, inst);
    persist();
    return inst;
  }

  function remove(id) {
    const had = instances.delete(id);
    if (had) persist();
    return had;
  }

  function get(id) {
    return instances.get(id) ?? null;
  }

  function listAll() {
    return [...instances.values()];
  }

  /**
   * Return objects within `radius` Chebyshev tiles of (x, y).
   * Default radius matches scenes' SCENE_RADIUS so "the LLM can see
   * what's in scene with them" reads consistently.
   */
  function nearby(x, y, radius = 3) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const out = [];
    for (const inst of instances.values()) {
      const d = Math.max(Math.abs(inst.x - x), Math.abs(inst.y - y));
      if (d <= radius) out.push({ ...inst, distance: d });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /**
   * Patch instance state. Returns the updated instance or null.
   * Used by the GM when applying affordance effects (slice 2).
   */
  function patchState(id, patch) {
    const inst = instances.get(id);
    if (!inst) return null;
    inst.state = { ...inst.state, ...(patch || {}) };
    persist();
    return inst;
  }

  /**
   * Drop everything. Mostly useful for tests; production callers
   * should prefer `remove(id)`.
   */
  function clear() {
    instances.clear();
    persist();
  }

  function snapshot() {
    return {
      count: instances.size,
      types: countTypes(),
      objects: listAll(),
    };
  }

  // ── persistence ──

  function loadFromDisk() {
    if (!fsImpl.existsSync(path)) return;
    let text;
    try { text = fsImpl.readFileSync(path, "utf-8"); }
    catch { return; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const inst = JSON.parse(line);
        if (inst?.id && OBJECT_TYPES[inst.type]) {
          instances.set(inst.id, inst);
        }
      } catch { /* skip malformed */ }
    }
  }

  function persist() {
    try {
      fsImpl.mkdirSync(dirname(path), { recursive: true });
      const lines = [];
      for (const inst of instances.values()) lines.push(JSON.stringify(inst));
      fsImpl.writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""));
    } catch (err) {
      console.error(`[objects] persist ${path} failed:`, err?.message || err);
    }
  }

  function countTypes() {
    const c = {};
    for (const inst of instances.values()) {
      c[inst.type] = (c[inst.type] ?? 0) + 1;
    }
    return c;
  }

  return {
    placeOne, remove, get, listAll, nearby, patchState, clear,
    snapshot,
    /** test escape hatch */
    _path: path,
  };
}

/**
 * Pre-seed a registry with a small starter set if it's empty. Keeps
 * "fresh sandbox" demos useful without requiring the user to curl
 * objects in manually. Idempotent — only runs when the registry has
 * zero placed instances.
 */
export function seedDefaults(registry, opts = {}) {
  if (registry.listAll().length > 0) return [];
  // Placements come from the active level file (levels/<name>.json).
  // Pass `opts.placements` to override (used by tests).
  const placements = opts.placements ?? [];
  return placements.map((p) => registry.placeOne(p));
}

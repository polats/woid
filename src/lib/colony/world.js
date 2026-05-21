/**
 * Colony world — pure state helpers and seeding.
 *
 * The world is a sparse 24×16 tile grid plus a flat dupe map plus a
 * small set of world-level resource counts. All pure functions; no
 * I/O, no React. The store layer wraps these for persistence + reactivity.
 *
 * See docs/design/agent-harness.md for the harness contract this world
 * plugs into. See tasks/490-colony-game-scaffold.md for the data shape.
 */

export const GRID_W = 24;
export const GRID_H = 16;
export const SCHEMA_VERSION = 1;

/** Tile types Colony understands. Empty tiles are not stored. */
export const TILE_TYPES = ['ore_deposit', 'bed', 'kitchen', 'wall'];

/** Need axes and bounds. */
export const NEED_AXES = ['food', 'energy'];
const NEED_MAX = 100;
const NEED_MIN = 0;

/** Decay per sim-tick for each need (4 Hz tick; calibrated so a fully
 *  rested dupe drains over ~5 real minutes / ~20 real minutes for food). */
export const NEED_DECAY = {
  energy: 100 / (5 * 60 * 4),  // ≈ 0.0833 per tick
  food:   100 / (20 * 60 * 4), // ≈ 0.0208 per tick
};

/** Threshold below which a need fires a `need_low` perception event. */
export const NEED_LOW_THRESHOLD = 30;

const tileKey = (x, y) => `${x},${y}`;

const NAME_POOL = [
  'Meep', 'Boggs', 'Catalina', 'Devon', 'Eluria',
  'Frey',  'Gossamer', 'Hex', 'Ivy', 'Joro',
];

export function tileAt(world, x, y) {
  return world?.grid?.tiles?.[tileKey(x, y)] ?? null;
}

export function setTile(world, x, y, tile) {
  const next = { ...world, grid: { ...world.grid, tiles: { ...world.grid.tiles } } };
  if (tile == null) delete next.grid.tiles[tileKey(x, y)];
  else next.grid.tiles[tileKey(x, y)] = tile;
  return next;
}

export function tilesOfType(world, type) {
  const out = [];
  for (const [key, tile] of Object.entries(world?.grid?.tiles ?? {})) {
    if (tile?.type === type) {
      const [x, y] = key.split(',').map(Number);
      out.push({ x, y, tile });
    }
  }
  return out;
}

export function eachDupe(world, fn) {
  for (const id of Object.keys(world?.dupes ?? {})) fn(world.dupes[id], id);
}

export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function clampNeed(v) {
  if (!Number.isFinite(v)) return NEED_MIN;
  return Math.max(NEED_MIN, Math.min(NEED_MAX, v));
}

/**
 * Build a fresh world from a deterministic seed. Same seed → same layout.
 * Plays the role of Phase 2's "starter scenario."
 */
export function createInitialWorld({ seed = 'colony-default' } = {}) {
  const rand = mulberry32(hashSeed(seed));
  const tiles = {};

  // A small ore vein along the left edge — 6 deposits with varying ore.
  for (let y = 2; y < 14; y += 2) {
    tiles[tileKey(2, y)] = { type: 'ore_deposit', ore: 80 + Math.floor(rand() * 40) };
  }

  // Sleep quarter (3 beds) along the right edge.
  tiles[tileKey(20, 4)] = { type: 'bed' };
  tiles[tileKey(20, 6)] = { type: 'bed' };
  tiles[tileKey(20, 8)] = { type: 'bed' };

  // Kitchen near the center — single source for `eat`.
  tiles[tileKey(12, 12)] = { type: 'kitchen' };

  // Walls framing the playfield (purely decorative; doesn't block movement).
  for (let x = 0; x < GRID_W; x++) {
    tiles[tileKey(x, 0)] = { type: 'wall' };
    tiles[tileKey(x, GRID_H - 1)] = { type: 'wall' };
  }
  for (let y = 1; y < GRID_H - 1; y++) {
    tiles[tileKey(0, y)] = { type: 'wall' };
    tiles[tileKey(GRID_W - 1, y)] = { type: 'wall' };
  }

  const dupes = {};
  const startingPositions = [
    { x: 10, y: 7 },
    { x: 12, y: 8 },
    { x: 14, y: 7 },
    { x: 12, y: 6 },
  ];
  for (let i = 0; i < 4; i++) {
    const id = `dupe-${i + 1}`;
    dupes[id] = makeDupe(id, NAME_POOL[i], startingPositions[i], rand);
  }

  return {
    version: SCHEMA_VERSION,
    lastTickWallClock: Date.now(),
    simTicks: 0,
    grid: { width: GRID_W, height: GRID_H, tiles },
    resources: { ore: 0, food: 200, oxygen: 100, material: 50 },
    dupes,
    events: [],
  };
}

export function makeDupe(id, name, pos, rand = Math.random, extras = {}) {
  return {
    id,
    name: name || id,
    pos: { x: pos?.x ?? Math.floor(GRID_W / 2), y: pos?.y ?? Math.floor(GRID_H / 2) },
    needs: {
      food:   60 + Math.floor(rand() * 40),
      energy: 60 + Math.floor(rand() * 40),
    },
    stress: 10,
    skills: {
      mining:  30 + Math.floor(rand() * 50),
      cooking: 20 + Math.floor(rand() * 50),
    },
    currentAction: 'idle',
    lastVerb: null,
    createdAt: Date.now(),
    // Cross-world link: when a dupe is instantiated from a pi-bridge
    // agent (drag-to-spawn), agentPubkey points back to it. Native
    // Colony dupes (default seed) leave this null.
    agentPubkey: extras.agentPubkey ?? null,
  };
}

export function findDupeByAgentPubkey(world, pubkey) {
  if (!pubkey) return null;
  for (const dupe of Object.values(world?.dupes ?? {})) {
    if (dupe.agentPubkey === pubkey) return dupe;
  }
  return null;
}

/**
 * Find an empty floor tile (not a wall, not any other tile type).
 * Used by debug-menu spawn.
 */
export function findEmptyTile(world, rand = Math.random) {
  for (let i = 0; i < 200; i++) {
    const x = 1 + Math.floor(rand() * (GRID_W - 2));
    const y = 1 + Math.floor(rand() * (GRID_H - 2));
    if (!tileAt(world, x, y)) return { x, y };
  }
  return { x: Math.floor(GRID_W / 2), y: Math.floor(GRID_H / 2) };
}

// ── helpers ───────────────────────────────────────────────────────

function hashSeed(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

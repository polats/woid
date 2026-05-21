import { useSyncExternalStore } from 'react';

/**
 * worldRegistry — module-level registry of live worlds.
 *
 * Each world view registers itself on mount via `useWorldRegistration`
 * so the agent overlay (SandboxCards) can render the right per-world
 * controls — e.g. one "Stop in <World>" button per world a character
 * is currently instantiated in.
 *
 * Shape:
 *   register('Shelter', {
 *     isInstantiated: (character) => boolean,
 *     stop: (character) => void | Promise<void>,
 *   })
 *
 * Only one world registers under a given name at a time; remounts
 * overwrite. Unregister on unmount.
 */

const worlds = new Map();
const listeners = new Set();
let snapshot = [];
let version = 0;

function rebuild() {
  version += 1;
  snapshot = Array.from(worlds.entries()).map(([world, def]) => ({ world, ...def, _v: version }));
}

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { /* eslint-disable-next-line no-console */ console.warn('[world-registry] listener threw', e); }
  }
}

export const worldRegistry = {
  register(world, def) {
    worlds.set(world, def);
    rebuild();
    notify();
  },
  unregister(world) {
    if (worlds.delete(world)) { rebuild(); notify(); }
  },
  /**
   * Bump the registry version without changing the worlds map.
   * A world view calls this when its internal state changes so any
   * subscriber (e.g. SandboxCards) re-evaluates `isInstantiated`.
   */
  bump() { rebuild(); notify(); },
  snapshot() { return snapshot; },
};

export function useRegisteredWorlds() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => snapshot,
    () => snapshot,
  );
}

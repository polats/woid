import { useSyncExternalStore } from 'react'
import { createShelterStore } from '../lib/shelterStore/index.js'

/**
 * Singleton ShelterStore for the app. Created lazily on first hook
 * call so the localStorage read happens at runtime (and in tests we
 * can swap the module before any component mounts).
 *
 * Use `useShelterStore()` to subscribe to the full snapshot and
 * `useShelterStoreApi()` to grab the raw store for mutations
 * without re-rendering on every change.
 */

let store = null
function ensure() {
  if (!store) store = createShelterStore()
  return store
}

/** React hook — returns the current store snapshot, re-renders on change. */
export function useShelterStore() {
  const s = ensure()
  return useSyncExternalStore(
    (cb) => s.subscribe(cb),
    () => s.getSnapshot(),
    () => s.getSnapshot(),
  )
}

/** Returns the underlying store API. Stable across renders. */
export function useShelterStoreApi() {
  return ensure()
}

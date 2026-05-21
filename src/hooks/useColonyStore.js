import { useSyncExternalStore } from 'react';
import { getColonyStore } from '../lib/colony/store-singleton.js';

/**
 * Colony store, shared with the WorldAdapter via store-singleton.js.
 * The hook subscribes via useSyncExternalStore so React re-renders on
 * each mutation.
 */

export function useColonyStore() {
  const s = getColonyStore();
  return useSyncExternalStore(
    (cb) => s.subscribe(cb),
    () => s.getSnapshot(),
    () => s.getSnapshot(),
  );
}

export function useColonyStoreApi() {
  return getColonyStore();
}

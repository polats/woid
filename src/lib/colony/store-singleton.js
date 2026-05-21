/**
 * Shared Colony store singleton.
 *
 * Both the React hook (`useColonyStore`) and the WorldAdapter
 * (`createColonyWorldAdapter`) need to operate on the same store
 * instance — otherwise a spawn through one side doesn't show up on the
 * other. This module is the single owner.
 */

import { createColonyStore } from './store.js';

let _store = null;

export function getColonyStore() {
  if (!_store) _store = createColonyStore();
  return _store;
}

/** Test seam. Resets the singleton. */
export function _resetColonyStore() {
  _store = null;
}

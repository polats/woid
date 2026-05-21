import { useSyncExternalStore } from 'react';

/**
 * Unified drop-toast queue — every world's drag-to-instantiate flow
 * pushes status updates through here so the toast shows up the same
 * way in Sims, Shelter, Colony, and any future world.
 *
 * Lifecycle:
 *   const id = dropToastApi.show('Instantiating Alice…', 'pending')
 *   ...async work...
 *   dropToastApi.update(id, 'Alice joined Colony', 'success')
 *
 * `success` and `error` toasts auto-dismiss after `AUTO_DISMISS_MS`.
 * `pending` stays visible until explicitly updated or dismissed.
 */

const AUTO_DISMISS_MS = 2800;

/** @type {Array<{ id: number, text: string, status: 'pending'|'success'|'error', at: number }>} */
let toasts = [];
const listeners = new Set();
let nextId = 1;

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { /* eslint-disable-next-line no-console */ console.warn('[drop-toast] listener threw', e); }
  }
}

function scheduleDismiss(id) {
  setTimeout(() => dropToastApi.dismiss(id), AUTO_DISMISS_MS);
}

export const dropToastApi = {
  show(text, status = 'pending') {
    const id = nextId++;
    toasts = [...toasts, { id, text, status, at: Date.now() }];
    notify();
    if (status === 'success' || status === 'error') scheduleDismiss(id);
    return id;
  },
  update(id, text, status) {
    let changed = false;
    toasts = toasts.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, text, status, at: Date.now() };
    });
    if (changed) {
      notify();
      if (status === 'success' || status === 'error') scheduleDismiss(id);
    }
  },
  dismiss(id) {
    const before = toasts.length;
    toasts = toasts.filter((t) => t.id !== id);
    if (toasts.length !== before) notify();
  },
  clear() {
    if (toasts.length > 0) { toasts = []; notify(); }
  },
};

export function useDropToasts() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => toasts,
    () => toasts,
  );
}

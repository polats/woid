/**
 * Overlay state — module-level pub/sub for AgentSandboxOverlay.
 *
 * Multiple components (FAB, keyboard shortcut, the overlay itself)
 * need to read/write `open`. A subscribable signal beats threading
 * state through a provider chain.
 */

import { useSyncExternalStore } from 'react';

let state = { open: false };
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[useOverlayState] subscriber threw', e);
    }
  }
}

function set(patch) {
  const next = { ...state, ...patch };
  if (next.open === state.open) return;
  state = next;
  notify();
}

export const overlayApi = {
  getState: () => state,
  open: () => set({ open: true }),
  close: () => set({ open: false }),
  toggle: () => set({ open: !state.open }),
};

function subscribe(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function useOverlayState() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

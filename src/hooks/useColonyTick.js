import { useEffect } from 'react';
import { useColonyStoreApi } from './useColonyStore.js';

/**
 * Foreground tick loop for Colony. Mirrors useShelterTick exactly —
 * 4 Hz behaviour tick, visibility-paused, with catch-up on resume.
 *
 * Calls `runBehaviour` once per advanced tick. The Colony view passes a
 * runBehaviour that invokes the brain for each dupe; null is also fine
 * (Phase 2a "dupes stand still" mode).
 */

const TICK_HZ = 4;

export function useColonyTick(runBehaviour) {
  const store = useColonyStoreApi();

  useEffect(() => {
    let interval = null;

    const start = () => {
      if (interval) return;
      interval = setInterval(() => {
        const advanced = store.advanceClock();
        if (advanced > 0 && typeof runBehaviour === 'function') {
          runBehaviour(store, advanced);
        }
      }, 1000 / TICK_HZ);
    };
    const stop = () => {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const advanced = store.advanceClock();
        if (advanced > 0 && typeof runBehaviour === 'function') {
          runBehaviour(store, advanced);
        }
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [store, runBehaviour]);
}

import { useEffect } from 'react'
import { tickAgents } from '../lib/shelterStore/index.js'
import { useShelterStoreApi } from './useShelterStore.js'

/**
 * Foreground tick loop for the Shelter sim.
 *
 * While the document is visible, advances the sim clock and runs
 * one behaviour tick at a fixed cadence. Pauses when backgrounded
 * (matches Fallout Shelter's pattern — closing the tab freezes
 * "bad things" but the clock catches up via offline cap on resume).
 *
 * Mount this once from the Shelter view. Multiple mounts are
 * harmless — each owns its own interval — but wasteful.
 */

const TICK_HZ = 4  // 4 Hz behaviour tick. Sim time advances at 1 sim-min/sec.

export function useShelterTick() {
  const store = useShelterStoreApi()

  useEffect(() => {
    let interval = null

    const start = () => {
      if (interval) return
      interval = setInterval(() => {
        const advanced = store.advanceClock()
        if (advanced > 0) tickAgents(store)
      }, 1000 / TICK_HZ)
    }
    const stop = () => {
      if (!interval) return
      clearInterval(interval)
      interval = null
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Resume — flush any backlog up-front (the next setInterval
        // tick is up to 250ms away; this gets us a fresh frame now).
        const advanced = store.advanceClock()
        if (advanced > 0) tickAgents(store)
        start()
      } else {
        stop()
      }
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [store])
}

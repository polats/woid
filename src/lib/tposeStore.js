// In-flight T-pose generations keyed by pubkey. Lives outside React so
// a generation survives drawer-tab switches and unmounts of AgentAssets.
// Components subscribe via useSyncExternalStore and render snapshots.
//
// `state.resultUrl` carries the bridge's tpose URL when done. Consumers
// use it in <img src=…>.

import { createSseJobStore } from './sseJobStore.js'

export const {
  start,
  cancel,
  getState,
  subscribe,
  isRunning,
} = createSseJobStore({
  pathFor: (pubkey) => `/characters/${pubkey}/generate-tpose/stream`,
  resultUrlField: 'tposeUrl',
})

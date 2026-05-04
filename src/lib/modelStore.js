// In-flight 3D-model (Trellis GLB) generations keyed by pubkey.
// Same shape as tposeStore — see ./sseJobStore.js for the runtime.
// `state.resultUrl` carries the bridge's GLB URL when done.

import { createSseJobStore } from './sseJobStore.js'

export const {
  start,
  cancel,
  getState,
  subscribe,
  isRunning,
} = createSseJobStore({
  pathFor: (pubkey) => `/characters/${pubkey}/generate-model/stream`,
  resultUrlField: 'modelUrl',
})

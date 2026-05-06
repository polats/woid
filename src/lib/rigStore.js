// In-flight rig + kimodo-finalise generations keyed by pubkey.
// Same shape as modelStore — see ./sseJobStore.js for the runtime.
// `state.resultUrl` is the bridge URL for the unfinalised rig.glb;
// `state.result` carries the full /generate-rig/stream `done` event
// payload (`kimodoCharId`, `label`, `backend`, `mapping`,
// `importedAt`) so the UI can label the imported character.

import { createSseJobStore } from './sseJobStore.js'

export const {
  start,
  cancel,
  getState,
  subscribe,
  isRunning,
} = createSseJobStore({
  pathFor: (pubkey) => `/characters/${pubkey}/generate-rig/stream`,
  resultUrlField: 'rigUrl',
})

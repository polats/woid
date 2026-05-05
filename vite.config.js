import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tasksApi } from './server/tasks.js'
import { diagramsApi } from './server/diagrams.js'
import { githubApi } from './server/github.js'
import { referencesApi } from './server/references.js'
import { chatApi } from './server/chat.js'
import { testingApi } from './server/testing.js'
import { spellsApi } from './server/spells.js'
import { kimodoApi } from './server/kimodo.js'

export default defineConfig({
  plugins: [react(), tasksApi(), diagramsApi(), githubApi(), referencesApi(), chatApi(), testingApi(), spellsApi(), kimodoApi()],
  server: {
    // Bind to 0.0.0.0 so the dev server is reachable from other
    // devices on the LAN (phones, tablets) — Vite prints a Network:
    // URL alongside Local: when this is enabled.
    host: true,
    // HMR is on by default; declared explicitly so it's documented and
    // overridable. The WebSocket runs over the same dev port so any
    // browser tab connected to /<port> picks up changes automatically.
    hmr: { overlay: true },
    // usePolling is a safety net for inotify exhaustion and editor-on-
    // network-share setups. interval: 200ms is a reasonable default.
    watch: { usePolling: false, interval: 200 },
  },
})

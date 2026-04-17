import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tasksApi } from './server/tasks.js'
import { diagramsApi } from './server/diagrams.js'
import { githubApi } from './server/github.js'
import { referencesApi } from './server/references.js'
import { chatApi } from './server/chat.js'

export default defineConfig({
  plugins: [react(), tasksApi(), diagramsApi(), githubApi(), referencesApi(), chatApi()],
})

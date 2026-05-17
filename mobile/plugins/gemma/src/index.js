// Thin JS shim. The native plugin is auto-registered when the
// Capacitor bridge boots (Android side has @CapacitorPlugin(name="Gemma")),
// so Capacitor.Plugins.Gemma is also reachable without this import — this
// file exists to give application code a clean named import + future
// TypeScript types.

import { registerPlugin } from '@capacitor/core'

export const Gemma = registerPlugin('Gemma')

import baseConfig from '../woid.config.json'

/**
 * Runtime config. Starts from `woid.config.json` (source of truth for
 * local dev and for non-URL settings like `home` / `features`) and then
 * overlays any `VITE_*` build-time env vars so the same bundle can be
 * deployed against different backends (e.g. Vercel prod pointing at
 * Railway services) without editing the JSON.
 *
 * Only agent-sandbox URLs are overridable today; add new keys here as
 * the prod surface grows.
 */
const env = import.meta.env ?? {}

const sandboxOverrides = {
  roomServerUrl: env.VITE_ROOM_SERVER_URL,
  bridgeUrl: env.VITE_BRIDGE_URL,
  relayUrl: env.VITE_RELAY_URL,
  jumbleUrl: env.VITE_JUMBLE_URL,
  defaultRoom: env.VITE_DEFAULT_ROOM,
}

const config = {
  ...baseConfig,
  agentSandbox: {
    ...(baseConfig.agentSandbox || {}),
    ...Object.fromEntries(
      Object.entries(sandboxOverrides).filter(([, v]) => v !== undefined && v !== '')
    ),
  },
}

export default config

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

// When loaded from a phone or other LAN device, "localhost" in the
// baked-in URLs points back at the *phone* — so every sandbox call
// fails. Rewrite localhost → the host the page was actually served
// from so the same dev URLs work cross-device. No-op when accessed
// from the dev machine itself.
function rewriteLocalhost(url) {
  if (typeof url !== 'string' || !url) return url
  if (typeof window === 'undefined') return url
  const host = window.location.hostname
  if (!host || host === 'localhost' || host === '127.0.0.1') return url
  return url.replace(/\/\/(localhost|127\.0\.0\.1)\b/g, `//${host}`)
}

const baseSandbox = baseConfig.agentSandbox || {}
const merged = {
  ...baseSandbox,
  ...Object.fromEntries(
    Object.entries(sandboxOverrides).filter(([, v]) => v !== undefined && v !== '')
  ),
}
const sandbox = Object.fromEntries(
  Object.entries(merged).map(([k, v]) => [k, rewriteLocalhost(v)])
)

const config = {
  ...baseConfig,
  agentSandbox: sandbox,
}

export default config

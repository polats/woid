/**
 * Read / update the bridge's LLM config used for layout generation.
 * The API key is server-side; the GET response includes only a hint
 * (`9247…21d2`) so the UI can show whether it's set.
 */
import config from '../config.js'

const BRIDGE_URL = config.agentSandbox?.bridgeUrl || ''

export async function getConfig() {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  const r = await fetch(`${BRIDGE_URL}/v1/llm/config`)
  if (!r.ok) throw new Error(`GET /v1/llm/config → ${r.status}`)
  return r.json()
}

/**
 * Patch the override file. Pass only the keys you want to change.
 * - `null` clears an override (reverts to env default).
 * - non-empty string sets it.
 * - empty string is treated as "leave unchanged" (UI can omit untouched fields).
 */
export async function setConfig(patch) {
  if (!BRIDGE_URL) throw new Error('no bridge configured')
  const r = await fetch(`${BRIDGE_URL}/v1/llm/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`POST /v1/llm/config → ${r.status}: ${body.slice(0, 200)}`)
  }
  return r.json()
}

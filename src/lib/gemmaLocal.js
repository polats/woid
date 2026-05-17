/**
 * Facade over the @woid/capacitor-gemma native plugin.
 *
 * On web/desktop, isAvailable() returns false and callers fall back to
 * the bridge-backed persona stream as before. On the Capacitor Android
 * build the plugin is registered automatically.
 *
 * Phase B surface:
 *   - downloadModel(url, onProgress)
 *   - modelStatus()
 *   - initModel()
 *   - generate(prompt, onToken)
 */

// LiteRT-LM canonical Android format for Gemma 4 E2B (~2.6 GB).
// HuggingFace anonymous mirror, Apache 2.0. Swap for your own CDN/R2
// bucket once you ship — HF rate-limits cold downloads.
export const DEFAULT_MODEL_URL =
  'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm'

function pluginRef() {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null
  return cap.Plugins && cap.Plugins.Gemma ? cap.Plugins.Gemma : null
}

export function isAvailable() {
  return !!pluginRef()
}

export async function ping() {
  const p = pluginRef()
  if (!p) throw new Error('Gemma plugin not available')
  return p.ping()
}

export async function modelStatus() {
  const p = pluginRef()
  if (!p) throw new Error('Gemma plugin not available')
  return p.modelStatus()
}

/**
 * Streams a model file (typically 1.5–2 GB) into app-private storage.
 * `onProgress({got, total, bytesPerSec})` fires roughly 4×/sec.
 * Idempotent — resolves immediately if the file is already present.
 */
export async function downloadModel(url, onProgress) {
  const p = pluginRef()
  if (!p) throw new Error('Gemma plugin not available')
  const off = await p.addListener('download-progress', (e) => { onProgress?.(e) })
  try {
    return await p.downloadModel({ url: url || DEFAULT_MODEL_URL })
  } finally {
    off?.remove?.()
  }
}

/** Loads the .task file into MediaPipe LlmInference. ~5–15s. */
export async function initModel() {
  const p = pluginRef()
  if (!p) throw new Error('Gemma plugin not available')
  return p.initModel()
}

/**
 * Streams Gemma 4 output via `token` events. Resolves with
 * `{ full, ms }` when generation ends.
 */
export async function generate(prompt, onToken) {
  const p = pluginRef()
  if (!p) throw new Error('Gemma plugin not available')
  const off = await p.addListener('token', (e) => { onToken?.(e) })
  try {
    return await p.generate({ prompt })
  } finally {
    off?.remove?.()
  }
}

/**
 * Facade over the @woid/capacitor-imagen native plugin.
 *
 * Backed by the local-dream subprocess pattern (xororz/local-dream,
 * CC-BY-NC). The plugin spawns a native binary that talks to the
 * Hexagon DSP via Qualcomm QNN. On Snapdragon 8 Gen 3 a 20-step
 * 512×512 SD 1.5 image lands in ~7–10 s.
 */

export const DEFAULT_MODEL_URL = null   // let plugin pick by chipset
export const DEFAULT_MODEL_ID = 'absolute_reality'

function pluginRef() {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null
  return cap.Plugins && cap.Plugins.Imagen ? cap.Plugins.Imagen : null
}

export function isAvailable() { return !!pluginRef() }

export async function ping() {
  const p = pluginRef(); if (!p) throw new Error('Imagen plugin not available')
  return p.ping()
}

export async function modelStatus(modelId = DEFAULT_MODEL_ID) {
  const p = pluginRef(); if (!p) throw new Error('Imagen plugin not available')
  return p.modelStatus({ modelId })
}

export async function downloadModel(url, onProgress, modelId = DEFAULT_MODEL_ID) {
  const p = pluginRef(); if (!p) throw new Error('Imagen plugin not available')
  const off = await p.addListener('download-progress', (e) => { onProgress?.(e) })
  try {
    return await p.downloadModel({ url: url || undefined, modelId })
  } finally { off?.remove?.() }
}

export async function initModel({ modelId = DEFAULT_MODEL_ID, width = 512, height = 512 } = {}) {
  const p = pluginRef(); if (!p) throw new Error('Imagen plugin not available')
  return p.initModel({ modelId, width, height })
}

export async function generate(
  { prompt, negativePrompt = '', steps = 20, cfg = 7.0, width = 512, height = 512, seed } = {},
  onStep,
) {
  const p = pluginRef(); if (!p) throw new Error('Imagen plugin not available')
  const off = await p.addListener('step', (e) => { onStep?.(e) })
  try {
    const args = { prompt, negativePrompt, steps, cfg, width, height }
    if (seed != null) args.seed = seed
    return await p.generate(args)
  } finally { off?.remove?.() }
}

export function fileSrcForWebview(path) {
  if (typeof window === 'undefined') return path
  const cap = window.Capacitor
  if (cap && typeof cap.convertFileSrc === 'function') return cap.convertFileSrc(path)
  return path
}

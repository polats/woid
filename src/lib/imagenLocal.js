/**
 * Facade over the @woid/capacitor-imagen native plugin.
 *
 * stable-diffusion.cpp under the hood (same library rmatif/Local-Diffusion
 * uses, Apache 2.0). Performance comes from runtime flags wired in the
 * native plugin: flash_attn + diffusion_flash_attn + TAESD decoder.
 */

// SD 1.5 precompiled for Snapdragon 8 Gen 3 (Samsung Galaxy S24) by
// Qualcomm AI Hub. Anonymous S3, ~680 MB zip → ~1.1 GB extracted.
// Runs entirely on Hexagon NPU via ONNX Runtime QNN execution provider.
export const DEFAULT_MODEL_URL =
  'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/stable_diffusion_v1_5/releases/v0.53.1/stable_diffusion_v1_5-precompiled_qnn_onnx-w8a16-qualcomm_snapdragon_8gen3.zip'

// Unused under MediaPipe — kept exported so older Personas.jsx imports
// don't break during the swap.
export const DEFAULT_TAESD_URL = ''

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

export async function modelStatus() {
  const p = pluginRef(); if (!p) throw new Error('Imagen plugin not available')
  return p.modelStatus()
}

export async function downloadModel(url, onProgress, taesdUrl) {
  const p = pluginRef(); if (!p) throw new Error('Imagen plugin not available')
  const off = await p.addListener('download-progress', (e) => { onProgress?.(e) })
  try {
    return await p.downloadModel({
      url: url || DEFAULT_MODEL_URL,
      taesdUrl: taesdUrl || DEFAULT_TAESD_URL,
    })
  } finally { off?.remove?.() }
}

export async function initModel() {
  const p = pluginRef(); if (!p) throw new Error('Imagen plugin not available')
  return p.initModel()
}

export async function generate(
  { prompt, steps = 20, width = 512, height = 512, seed = 0 } = {},
  onStep,
) {
  const p = pluginRef(); if (!p) throw new Error('Imagen plugin not available')
  const off = await p.addListener('step', (e) => { onStep?.(e) })
  try {
    return await p.generate({ prompt, steps, width, height, seed })
  } finally { off?.remove?.() }
}

export function fileSrcForWebview(path) {
  if (typeof window === 'undefined') return path
  const cap = window.Capacitor
  if (cap && typeof cap.convertFileSrc === 'function') return cap.convertFileSrc(path)
  return path
}

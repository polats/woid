/**
 * LLM provider dispatch — unified entry point for both pi-bridge and brain-server.
 *
 * Two calling conventions, both supported:
 *
 *   1. Explicit provider (pi-bridge's pattern):
 *        generateJson({ provider: "gemini", systemPrompt, messages, model, env })
 *
 *   2. Auto-detect from env (brain-server's pattern):
 *        chatJson({ systemPrompt, messages, model })  // provider resolved from env
 *
 * Both return { text, usage?, model? }.
 */

import * as gemini from "./gemini.js";
import * as openaiCompat from "./openai-compat.js";

const NIM_DEFAULT_ENDPOINT = "https://integrate.api.nvidia.com/v1";

// ──────────────────────────────────────────────────────────────────────────
// Auto-detection helpers (used by brain-server; pi-bridge can ignore)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pick a provider. Explicit `LLM_PROVIDER` env var wins. Otherwise auto-detect:
 *  - GEMINI_API_KEY → gemini
 *  - LLM_BASE_URL → openai-compat (the "generic" cloud slot)
 *  - NVIDIA_NIM_API_KEY → nim
 *  - LOCAL_LLM_BASE_URL → local
 *  - else utility-only (no LLM)
 */
export function resolveProvider(env = process.env) {
  const explicit = env.LLM_PROVIDER?.toLowerCase();
  if (explicit && explicit !== "auto") return explicit;
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.LLM_BASE_URL) return "openai-compat";
  if (env.NVIDIA_NIM_API_KEY) return "nim";
  if (env.LOCAL_LLM_BASE_URL) return "local";
  return "utility-only";
}

export function llmAvailable(env = process.env) {
  const p = resolveProvider(env);
  if (p === "utility-only") return false;
  if (p === "gemini" || p === "google") return !!env.GEMINI_API_KEY;
  if (p === "openai-compat" || p === "openai") return !!env.LLM_BASE_URL;
  if (p === "nim" || p === "nvidia" || p === "nvidia-nim") return !!env.NVIDIA_NIM_API_KEY;
  if (p === "local") return !!env.LOCAL_LLM_BASE_URL;
  return false;
}

let _localModelCache = null;
async function _probeLocalModel(env = process.env) {
  try {
    const base = env.LOCAL_LLM_BASE_URL.replace(/\/+$/, "");
    const res = await fetch(`${base}/models`);
    const j = await res.json();
    const first = j?.models?.[0] ?? j?.data?.[0];
    const name = first?.id ?? first?.name ?? first?.model;
    if (name) _localModelCache = name.replace(/^[^/]+\//, "").replace(/-GGUF.*/, "");
  } catch { /* swallow */ }
}

export function llmProviderInfo(env = process.env) {
  const provider = resolveProvider(env);
  let model = null;
  switch (provider) {
    case "gemini":
    case "google":
      model = env.GEMINI_MODEL ?? "gemini-2.5-flash"; break;
    case "nim":
    case "nvidia":
    case "nvidia-nim":
      model = env.NIM_MODEL ?? "meta/llama-3.3-70b-instruct"; break;
    case "openai-compat":
    case "openai":
      model = env.LLM_MODEL ?? "gpt-4o-mini"; break;
    case "local":
      model = _localModelCache ?? env.LOCAL_LLM_MODEL ?? "local";
      if (!_localModelCache && env.LOCAL_LLM_BASE_URL) _probeLocalModel(env);
      break;
  }
  return { provider, ready: llmAvailable(env), model };
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatch
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string} [opts.provider]   Optional explicit provider; auto-detected if omitted.
 * @param {string} opts.systemPrompt
 * @param {Array} opts.messages
 * @param {string} [opts.model]
 * @param {object} [opts.env]        env source (default process.env)
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {boolean} [opts.disableThinking]   Disable Gemma/Qwen reasoning mode (auto-on for "local")
 */
export async function generateJson(opts) {
  const env = opts.env ?? process.env;
  const provider = (opts.provider ?? resolveProvider(env)).toLowerCase();
  if (provider === "utility-only") {
    throw new Error("no LLM configured (set LLM_PROVIDER and LLM_BASE_URL / GEMINI_API_KEY / NVIDIA_NIM_API_KEY / LOCAL_LLM_BASE_URL)");
  }

  switch (provider) {
    case "gemini":
    case "google":
      return gemini.generateJson({
        ...opts,
        apiKey: env.GEMINI_API_KEY ?? "",
        model: opts.model ?? env.GEMINI_MODEL ?? "gemini-2.5-flash",
      });

    case "openai-compat":
    case "openai":
      return openaiCompat.generateJson({
        ...opts,
        endpoint: env.LLM_BASE_URL,
        apiKey: env.LLM_API_KEY ?? "",
        model: opts.model ?? env.LLM_MODEL ?? "gpt-4o-mini",
      });

    case "nim":
    case "nvidia":
    case "nvidia-nim":
      return openaiCompat.generateJson({
        ...opts,
        endpoint: env.NVIDIA_NIM_BASE_URL ?? NIM_DEFAULT_ENDPOINT,
        apiKey: env.NVIDIA_NIM_API_KEY ?? "",
        model: opts.model ?? env.NIM_MODEL ?? "meta/llama-3.3-70b-instruct",
      });

    case "local":
      return openaiCompat.generateJson({
        ...opts,
        endpoint: env.LOCAL_LLM_BASE_URL,
        apiKey: "",
        model: opts.model ?? env.LOCAL_LLM_MODEL ?? "local",
        // Local Gemma 4 / Qwen reasoning models burn tokens on thinking
        // before structured output. Default to disabling unless caller overrides.
        disableThinking: opts.disableThinking ?? true,
      });

    default:
      throw new Error(`unknown provider "${provider}" (supported: gemini, openai-compat, nim, local)`);
  }
}

// brain-server's preferred name (auto-detect by default)
export const chatJson = generateJson;

/** Pi-bridge legacy convenience for tests. */
export function createStubProvider(impl) {
  return { generateJson: impl };
}

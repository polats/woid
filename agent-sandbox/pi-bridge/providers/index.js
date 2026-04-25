/**
 * Provider dispatch for DirectHarness.
 *
 * Each provider exposes `generateJson({ systemPrompt, messages, model, ... })`
 * returning `{ text, usage? }`. DirectHarness picks one based on the
 * character's `provider` field (inferred from the model id if needed).
 *
 * Keep this file tiny — it's just a switch. Providers themselves live
 * in sibling files and stay focused.
 */

import * as gemini from "./gemini.js";
import * as openaiCompat from "./openai-compat.js";

const NIM_DEFAULT_ENDPOINT = "https://integrate.api.nvidia.com/v1";

export async function generateJson({ provider, systemPrompt, messages, model, env = process.env }) {
  switch (provider) {
    case "google":
    case "gemini":
      return gemini.generateJson({
        systemPrompt,
        messages,
        model,
        apiKey: env.GEMINI_API_KEY || "",
      });
    case "nvidia":
    case "nvidia-nim":
    case "nim":
      return openaiCompat.generateJson({
        endpoint: env.NVIDIA_NIM_BASE_URL || NIM_DEFAULT_ENDPOINT,
        apiKey: env.NVIDIA_NIM_API_KEY || "",
        systemPrompt,
        messages,
        model,
      });
    case "local":
      return openaiCompat.generateJson({
        endpoint: env.LOCAL_LLM_BASE_URL || "",
        apiKey: "",
        systemPrompt,
        messages,
        model,
      });
    default:
      throw new Error(`unknown provider "${provider}" (supported: google, nvidia-nim, local)`);
  }
}

/**
 * Convenience for tests: inject a stubbed generateJson.
 */
export function createStubProvider(impl) {
  return { generateJson: impl };
}

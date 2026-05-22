/**
 * OpenAI-compatible chat completions provider.
 *
 * Covers NIM (endpoint: https://integrate.api.nvidia.com/v1) and local
 * llama.cpp / vLLM / Ollama (endpoint: $LOCAL_LLM_BASE_URL). Both speak
 * the same /v1/chat/completions API with an OpenAI-shaped payload.
 *
 * Uses plain fetch — no SDK dependency. Requests structured JSON via
 * `response_format: { type: "json_object" }` which NIM and llama.cpp
 * both honour (best-effort; we still defensively parse in the caller).
 *
 * Canonical home: agent-sandbox/woid-core/llm/openai-compat.js.
 * pi-bridge/providers/openai-compat.js re-exports for back-compat.
 */

/**
 * @param {Object} opts
 * @param {string} opts.endpoint     Base URL including /v1 (e.g. "https://integrate.api.nvidia.com/v1").
 * @param {string} opts.apiKey       Bearer token. Empty string OK for local llama.cpp without auth.
 * @param {string} opts.systemPrompt
 * @param {Array<{role:'user'|'assistant',content:string}>} opts.messages
 * @param {string} opts.model
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {boolean} [opts.disableThinking]  Gemma 4 / Qwen reasoning models burn
 *   tokens on chain-of-thought before emitting structured output. Set true to
 *   bypass via chat_template_kwargs.enable_thinking=false.
 * @returns {Promise<{ text: string, usage?: {input:number,output:number,total:number} }>}
 */
export async function generateJson({
  endpoint, apiKey, systemPrompt, messages, model,
  timeoutMs = 90_000, maxTokens = 1024, temperature = 0.7, disableThinking = false,
}) {
  if (!endpoint) throw new Error("openai-compat: endpoint required");
  const url = endpoint.replace(/\/+$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    response_format: { type: "json_object" },
    temperature,
    max_tokens: maxTokens,
  };
  if (disableThinking) body.chat_template_kwargs = { enable_thinking: false };

  try {
    const res = await fetch(url, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`openai-compat ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    const payload = await res.json();
    const text = payload?.choices?.[0]?.message?.content ?? "";
    const u = payload?.usage;
    const usage = u ? {
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      total: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
    } : undefined;
    return { text, usage, model };
  } finally {
    clearTimeout(timer);
  }
}

// Alias preserved for brain-server's preferred naming.
export const chatJson = generateJson;

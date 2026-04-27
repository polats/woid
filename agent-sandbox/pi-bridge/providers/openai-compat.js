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
 */

/**
 * @param {Object} opts
 * @param {string} opts.endpoint   Base URL including /v1 (e.g. "https://integrate.api.nvidia.com/v1").
 * @param {string} opts.apiKey     Bearer token. Empty string OK for local llama.cpp without auth.
 * @param {string} opts.systemPrompt
 * @param {Array<{role:'user'|'assistant',content:string}>} opts.messages
 * @param {string} opts.model
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ text: string, usage?: {input:number,output:number,totalTokens:number,cost?:number} }>}
 */
export async function generateJson({ endpoint, apiKey, systemPrompt, messages, model, timeoutMs = 60_000, maxTokens = 1024 }) {
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
    temperature: 0.7,
    // Default 1024 covers small Action JSON schemas. Recap and other
    // prose-heavy callers should bump this so JSON doesn't truncate.
    max_tokens: maxTokens,
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
    const usage = u
      ? {
          input: u.prompt_tokens ?? 0,
          output: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
        }
      : undefined;
    return { text, usage };
  } finally {
    clearTimeout(timer);
  }
}

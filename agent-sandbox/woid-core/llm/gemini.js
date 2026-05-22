/**
 * Gemini provider — thin wrapper around @google/genai's JSON mode.
 * Canonical home: agent-sandbox/woid-core/llm/gemini.js.
 * pi-bridge/providers/gemini.js re-exports for back-compat.
 */

import { GoogleGenAI } from "@google/genai";

let _clientKey = null;
let _client = null;

function client(apiKey) {
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  if (_client && _clientKey === apiKey) return _client;
  _client = new GoogleGenAI({ apiKey });
  _clientKey = apiKey;
  return _client;
}

/**
 * @param {Object} opts
 * @param {string} opts.systemPrompt
 * @param {Array<{role:'user'|'assistant', content:string}>} opts.messages
 * @param {string} opts.model
 * @param {string} opts.apiKey
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.temperature]
 * @returns {Promise<{ text: string, usage?: {input:number,output:number,total:number} }>}
 */
export async function generateJson({ systemPrompt, messages, model, apiKey, timeoutMs = 30_000, temperature = 0.7 }) {
  const ai = client(apiKey);
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content) }],
  }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        temperature,
      },
    });
    const text = response?.text ?? "";
    const u = response?.usageMetadata;
    const usage = u ? {
      input: u.promptTokenCount ?? 0,
      output: u.candidatesTokenCount ?? 0,
      total: u.totalTokenCount ?? ((u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0)),
    } : undefined;
    return { text, usage, model };
  } finally {
    clearTimeout(timer);
  }
}

// Alias preserved for brain-server's preferred naming.
export const chatJson = generateJson;

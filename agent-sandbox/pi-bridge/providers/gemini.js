/**
 * Gemini provider — thin wrapper around @google/genai's JSON mode.
 * Used by DirectHarness; mirrors apoc-radio-v2's `gemini.js:generateJson`.
 *
 * Single call per turn. Expects the caller to supply a system prompt
 * that instructs the model to return JSON matching our Action schema.
 * The provider asks the model for JSON explicitly via responseMimeType
 * so we get one deterministic parse path.
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
 * Generate a JSON response given a system prompt and message history.
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt
 * @param {Array<{role:'user'|'assistant', content:string}>} opts.messages
 * @param {string} opts.model   Gemini model id (e.g. 'gemini-2.5-flash').
 * @param {string} opts.apiKey
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ text: string, usage?: {input:number,output:number,totalTokens:number,cost?:number} }>}
 */
export async function generateJson({ systemPrompt, messages, model, apiKey, timeoutMs = 30_000 }) {
  const ai = client(apiKey);

  // Gemini expects `contents` as an array of { role, parts: [{ text }] }.
  // It has no dedicated "system" role — that's passed via config.systemInstruction.
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
        // Keep temperature low so JSON stays well-formed. Personality
        // still comes through because the system prompt carries the
        // persona — the schema just constrains output.
        temperature: 0.7,
      },
    });

    const text = response?.text ?? "";
    const u = response?.usageMetadata;
    const usage = u
      ? {
          input: u.promptTokenCount ?? 0,
          output: u.candidatesTokenCount ?? 0,
          totalTokens: u.totalTokenCount ?? ((u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0)),
        }
      : undefined;
    return { text, usage };
  } finally {
    clearTimeout(timer);
  }
}

// Persona generation. Thin wrapper — most logic lives in woid-core/persona/.

import { chatJson } from './llm/index.js';
import { DEFAULT_SYSTEM, defaultUserPrompt } from '../../woid-core/persona/prompts.js';
import { parsePersonaJson } from '../../woid-core/persona/parse.js';

/**
 * @param {{ seed?: string, model?: string }} opts
 */
export async function generatePersona({ seed, model } = {}) {
  const { text, usage, model: usedModel } = await chatJson({
    systemPrompt: DEFAULT_SYSTEM,
    messages: [{ role: 'user', content: defaultUserPrompt(seed) }],
    model,
    maxTokens: 400,
    temperature: 0.9,
  });

  const persona = parsePersonaJson(text);
  return { ...persona, _usage: usage, _model: usedModel };
}

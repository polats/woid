import { Router } from 'express';
import { ok, err, wrap } from '../lib/envelope.js';
import { llmAvailable } from '../lib/llm/index.js';
import { generatePersona } from '../lib/persona.js';

export const personaRouter = Router();

personaRouter.post('/persona/generate', wrap(async (req, res) => {
  if (!llmAvailable()) {
    return res.status(503).json(err('provider_error',
      'LLM_PROVIDER not configured (set LLM_PROVIDER and LLM_BASE_URL/etc in agent-sandbox/.env)'));
  }
  const { seed, model } = req.body ?? {};
  const startTs = Date.now();
  const persona = await generatePersona({ seed, model });
  res.json(ok({
    persona: {
      name: persona.name,
      about: persona.about,
      avatar_hint: persona.avatar_hint,
      vibe: persona.vibe,
    },
    ms: Date.now() - startTs,
    usage: persona._usage,
    model: persona._model,
  }));
}));

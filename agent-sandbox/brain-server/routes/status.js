import { Router } from 'express';
import { ok, wrap } from '../lib/envelope.js';
import { state } from '../lib/state.js';
import { llmProviderInfo } from '../lib/llm/index.js';

export const statusRouter = Router();

statusRouter.get('/status', wrap(async (_req, res) => {
  res.json(ok({
    state: 'ready',
    binary:   { present: false, version: null },
    model:    { present: false, name: null },
    llm:      llmProviderInfo(),
    uptime_ms: Date.now() - state.bootedAt,
  }));
}));

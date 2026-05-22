import { Router } from 'express';
import { ok, wrap } from '../lib/envelope.js';
import { listVerbs } from '../lib/verbs.js';

export const verbsRouter = Router();

verbsRouter.get('/verbs', wrap(async (_req, res) => {
  res.json(ok({ verbs: listVerbs() }));
}));

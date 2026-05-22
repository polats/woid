import { Router } from 'express';
import { ok, err, wrap } from '../lib/envelope.js';
import { state, makeCharacter } from '../lib/state.js';

export const characterRouter = Router();

characterRouter.post('/character', wrap(async (req, res) => {
  const { id, identity, brain_provider } = req.body ?? {};
  if (!id || typeof id !== 'string') {
    return res.status(400).json(err('invalid_args', 'id is required (string)'));
  }
  const character = makeCharacter({ id, identity, brain_provider });
  res.json(ok({ character }));
}));

characterRouter.get('/character/:id', wrap(async (req, res) => {
  const c = state.characters.get(req.params.id);
  if (!c) return res.status(404).json(err('unknown_character', `no character with id=${req.params.id}`));
  res.json(ok({ character: c }));
}));

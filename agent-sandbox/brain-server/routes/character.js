import { Router } from 'express';
import { ok, err, wrap } from '../lib/envelope.js';
import { state, makeCharacter, snapshotCharacter } from '../lib/state.js';

export const characterRouter = Router();

characterRouter.post('/character', wrap(async (req, res) => {
  const { id, identity, brain_provider } = req.body ?? {};
  if (!id || typeof id !== 'string') {
    return res.status(400).json(err('invalid_args', 'id is required (string)'));
  }
  makeCharacter({ id, identity, brain_provider });
  res.json(ok({ character: snapshotCharacter(id) }));
}));

characterRouter.get('/character/:id', wrap(async (req, res) => {
  const c = snapshotCharacter(req.params.id);
  if (!c) return res.status(404).json(err('unknown_character', `no character with id=${req.params.id}`));
  res.json(ok({ character: c }));
}));

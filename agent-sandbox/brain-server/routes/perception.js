import { Router } from 'express';
import { ok, err, wrap } from '../lib/envelope.js';
import { state } from '../lib/state.js';

export const perceptionRouter = Router();

/**
 * POST /perception/event — push events into one or more characters' buses.
 *
 * Body shape: { target: "<id>" | "*all*" | "*nearby*", event: PerceptionEvent }
 * For now, "*nearby*" delivers to every registered character (we don't
 * track spatial nearness server-side yet). "*all*" same. Specific ids
 * deliver to just that character.
 */
perceptionRouter.post('/perception/event', wrap(async (req, res) => {
  const { target, event } = req.body ?? {};
  if (!event || typeof event !== 'object') {
    return res.status(400).json(err('invalid_args', 'event is required'));
  }
  if (typeof event.kind !== 'string' || !event.kind) {
    return res.status(400).json(err('invalid_args', 'event.kind required'));
  }

  let delivered = [];
  if (target === '*nearby*' || target === '*all*') {
    for (const id of state.characters.keys()) {
      state.perception.appendOne(id, event);
      delivered.push(id);
    }
  } else if (typeof target === 'string' && target) {
    if (!state.characters.has(target)) {
      return res.status(404).json(err('unknown_character', target));
    }
    state.perception.appendOne(target, event);
    delivered.push(target);
  } else {
    return res.status(400).json(err('invalid_args', 'target required (id or *nearby*/*all*)'));
  }

  res.json(ok({ delivered_to: delivered }));
}));

/**
 * GET /perception/:id?since=<ts>&limit=<n> — recent events for a character.
 */
perceptionRouter.get('/perception/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!state.characters.has(id)) {
    return res.status(404).json(err('unknown_character', id));
  }
  const since = req.query.since ? Number(req.query.since) : undefined;
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
  const events = state.perception.eventsSince(id, since).slice(-limit);
  res.json(ok({ events }));
}));

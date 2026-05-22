import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ok, err, wrap } from '../lib/envelope.js';
import { state } from '../lib/state.js';
import { step as utilityStep } from '../lib/utility-brain.js';
import { step as llmStep } from '../lib/llm-brain.js';
import { llmAvailable } from '../lib/llm/index.js';

export const brainRouter = Router();

// Map<trace_id, TraceEntry>   recent traces, ring-buffered per character
const traceById = new Map();
const tracesByChar = new Map();
const TRACE_RING_SIZE = 50;

function pushTrace(charId, traceEntry) {
  traceById.set(traceEntry.trace_id, traceEntry);
  let buf = tracesByChar.get(charId);
  if (!buf) { buf = []; tracesByChar.set(charId, buf); }
  buf.push(traceEntry);
  if (buf.length > TRACE_RING_SIZE) {
    const dropped = buf.shift();
    traceById.delete(dropped.trace_id);
  }
}

function replaceTrace(charId, traceId, newEntry) {
  const buf = tracesByChar.get(charId);
  if (!buf) return;
  const idx = buf.findIndex((e) => e.trace_id === traceId);
  if (idx === -1) { pushTrace(charId, newEntry); return; }
  buf[idx] = newEntry;
  traceById.set(traceId, newEntry);
}

brainRouter.post('/brain/step', wrap(async (req, res) => {
  const obs = req.body;
  if (!obs || typeof obs.selfId !== 'string') {
    return res.status(400).json(err('invalid_args', 'Observation.selfId required'));
  }
  const character = state.characters.get(obs.selfId);
  if (!character) {
    return res.status(404).json(err('unknown_character', `POST /character first for id=${obs.selfId}`));
  }

  // Pick brain: utility (default, sync, no cost) or llm (uses LLM_PROVIDER).
  const useLlm = character.brain_provider === 'llm' && llmAvailable();
  const trace_id = randomUUID();
  const startedAt = Date.now();

  // Write a "pending" entry IMMEDIATELY so clients can derive isThinking.
  // The completed entry replaces it (same trace_id) when the call finishes.
  // This matches the call-my-ghost interactionLog pattern.
  if (useLlm) {
    pushTrace(obs.selfId, {
      trace_id, started_at: startedAt, ended_at: 0,
      ts: startedAt, turns: [], actions_emitted: [], reasoning: '(thinking…)',
    });
  }

  try {
    const { actions, trace } = useLlm
      ? await llmStep({ obs, character })
      : utilityStep(obs);

    replaceTrace(obs.selfId, trace_id, {
      trace_id, started_at: startedAt, ended_at: Date.now(),
      ts: trace.ts, turns: trace.turns, actions_emitted: actions, reasoning: trace.reasoning,
    });

    res.json(ok({ actions, trace_id }));
  } catch (e) {
    replaceTrace(obs.selfId, trace_id, {
      trace_id, started_at: startedAt, ended_at: Date.now(),
      ts: Date.now(), turns: [], actions_emitted: [], reasoning: `(error: ${e.message})`,
    });
    throw e;
  }
}));

// No-op endpoint to "request" a tick — actual tick scheduling is sbox-side
// (sbox owns the tick loop). This is here for external tooling / curl,
// and so a future sbox restart can pick up scheduled ticks.
brainRouter.post('/brain/tick/:id', wrap(async (req, res) => {
  if (!state.characters.has(req.params.id)) {
    return res.status(404).json(err('unknown_character', req.params.id));
  }
  res.json(ok({ requested_at: Date.now(), character_id: req.params.id }));
}));

brainRouter.get('/brain/trace/:id', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const buf = tracesByChar.get(req.params.id) ?? [];
  const entries = buf.slice(-limit).reverse();
  res.json(ok({ entries }));
}));

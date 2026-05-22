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

// Per-character last-seen timestamp so we only inject delta perception events.
const lastPerceptionTs = new Map();

brainRouter.post('/brain/step', wrap(async (req, res) => {
  const obs = req.body;
  if (!obs || typeof obs.selfId !== 'string') {
    return res.status(400).json(err('invalid_args', 'Observation.selfId required'));
  }
  const character = state.characters.get(obs.selfId);
  if (!character) {
    return res.status(404).json(err('unknown_character', `POST /character first for id=${obs.selfId}`));
  }

  // Sync needs from sbox-side (authoritative for now) into the tracker so
  // /character/:id and other consumers see current values.
  if (obs.needs && typeof obs.needs === 'object') {
    for (const [axis, value] of Object.entries(obs.needs)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        state.needs.setAxis(obs.selfId, axis, value);
      }
    }
  }

  // Enrich observation with server-side trackers:
  //  - perception: delta events since last brain/step for this character
  //  - moodlets: currently-active aggregate
  const since = lastPerceptionTs.get(obs.selfId);
  const perceptionDelta = state.perception.eventsSince(obs.selfId, since);
  if (perceptionDelta.length > 0) {
    lastPerceptionTs.set(obs.selfId, perceptionDelta[perceptionDelta.length - 1].ts);
  }
  const activeMoodlets = state.moodlets.listActive(obs.selfId);

  // Merge: sbox-supplied perception (e.g. immediate world events) + server-side
  // delta from the bus. Caller's array wins on dedupe via ts.
  const mergedPerception = mergePerception(obs.perception ?? [], perceptionDelta);

  const enriched = {
    ...obs,
    perception: mergedPerception,
    moodlets: activeMoodlets,
  };

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
      ? await llmStep({ obs: enriched, character })
      : utilityStep(enriched);

    // Side-effect: emit moodlets for certain actions. This is the
    // brain-server-side counterpart to sbox's effect interpreter — the
    // character feels these even if sbox didn't push back.
    for (const a of actions) emitMoodletForAction(obs.selfId, a);

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

// Merge two perception event arrays, dedupe by (kind, ts).
function mergePerception(fromCaller, fromBus) {
  const seen = new Set();
  const out = [];
  for (const e of [...fromBus, ...fromCaller]) {
    if (!e || typeof e !== 'object') continue;
    const key = `${e.kind}@${e.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  // Newest last; cap to ~30 to keep prompts small
  out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return out.slice(-30);
}

// Tiny mood feedback: every action a character takes nudges a moodlet.
// Keeps the moodlet stream alive without sbox having to push effects back.
function emitMoodletForAction(charId, action) {
  if (!action || typeof action !== 'object') return;
  const verb = action.verb;
  if (verb === 'say') {
    state.moodlets.emit(charId, {
      tag: 'spoke_to_someone', weight: 2, reason: 'connected with a housemate',
      source: 'social', duration_ms: 30 * 60 * 1000,
    });
  } else if (verb === 'sit') {
    state.moodlets.emit(charId, {
      tag: 'rested_a_moment', weight: 1, reason: 'sat down a moment',
      source: 'biology', duration_ms: 60 * 60 * 1000,
    });
  } else if (verb === 'sleep') {
    state.moodlets.emit(charId, {
      tag: 'slept_well', weight: 4, reason: 'slept properly',
      source: 'biology', duration_ms: 8 * 60 * 60 * 1000,
    });
  } else if (verb === 'eat' || verb === 'eat_at_table') {
    state.moodlets.emit(charId, {
      tag: 'had_a_meal', weight: 2, reason: 'a satisfying meal',
      source: 'biology', duration_ms: 4 * 60 * 60 * 1000,
    });
  }
}

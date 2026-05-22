/**
 * UtilityBrain — score advertised verbs by per-character considerations,
 * pick top-K. The reference Utility AI implementation for the harness.
 *
 * The classic Sims pattern (smart objects advertising utility) and the
 * 2009/2010 Dave Mark utility-theory talks land here. Each scorer is a
 * pure function over the candidate (verb + args) and the Observation;
 * scores compose multiplicatively (so a single 0 from a hard constraint
 * vetoes the candidate).
 *
 * See docs/research/foundational-ai-patterns.md and
 * docs/design/agent-harness.md §4 for the wider context.
 *
 * Usage:
 *
 *   import { createUtilityBrain } from 'src/lib/harness/impls/brains/UtilityBrain.js'
 *
 *   const brain = createUtilityBrain({
 *     id: `colony-utility-${dupeId}`,
 *     candidates: (obs) => world.advertisedJobsFor(obs.selfId).map(j => ({
 *       verb: 'take_job',
 *       args: { jobId: j.id, x: j.x, y: j.y },
 *     })),
 *     scorers: [
 *       (cand, obs) => needPressureFor(obs.needs, cand) ?? 1,
 *       (cand, obs) => proximityScore(obs, cand) ?? 1,
 *     ],
 *     topK: 1,
 *   })
 *
 *   const actions = await brain.step(observation)
 */

/**
 * @typedef {{ verb: string, args: Record<string, unknown> }} Candidate
 */

/**
 * @typedef {(cand: Candidate, obs: import('../../types.js').Observation) => number} Scorer
 */

/**
 * @typedef {Object} UtilityBrainOpts
 * @property {string} id
 * @property {(obs: import('../../types.js').Observation) => Candidate[]} candidates
 *   Returns the set of (verb, args) candidates the brain may pick from this tick.
 *   Returning [] is valid — the brain emits no actions that tick.
 * @property {Scorer[]} scorers
 *   Each scorer returns a non-negative number; 0 vetoes the candidate.
 *   Final score = product of scorer outputs.
 * @property {number} [topK]                Default 1.
 * @property {Candidate} [fallback]
 *   Emitted when no candidate scores > 0 (e.g. { verb: 'idle', args: {} }).
 *   If omitted, an empty action list is returned in that case.
 * @property {(message: string, data?: unknown) => void} [log]
 *   Optional logger. Default no-op.
 */

/**
 * @param {UtilityBrainOpts} opts
 * @returns {import('../../types.js').Brain}
 */
export function createUtilityBrain(opts) {
  if (!opts?.id) throw new Error('createUtilityBrain: id required');
  if (typeof opts.candidates !== 'function') {
    throw new Error('createUtilityBrain: candidates(obs) function required');
  }
  if (!Array.isArray(opts.scorers) || opts.scorers.length === 0) {
    throw new Error('createUtilityBrain: at least one scorer required');
  }
  const topK = Number.isFinite(opts.topK) ? Math.max(1, opts.topK) : 1;
  const log = opts.log ?? (() => {});

  /**
   * Capture per-candidate score breakdowns when an external observer
   * passes a `debugSink` via `step(obs, { debugSink })`. Used by the
   * Inspector tab to render decisions; absent for production callers.
   */
  async function step(obs, runtime = {}) {
    const debug = runtime.debugSink;
    const scorerNames = opts.scorers.map((s, i) => s.name || `scorer${i}`);
    const candidates = opts.candidates(obs) ?? [];
    if (candidates.length === 0) {
      const actions = opts.fallback ? [opts.fallback] : [];
      if (debug) debug({ candidates: [], scorerNames, winner: actions[0] ?? null, fallback: true });
      return actions;
    }
    const ranked = [];
    /** @type {Array<{ verb: string, args: object, scores: Record<string, number>, final: number, vetoedBy?: string }>} */
    const rows = [];
    for (const cand of candidates) {
      let score = 1;
      const scores = {};
      let vetoedBy;
      for (let i = 0; i < opts.scorers.length; i++) {
        const scorer = opts.scorers[i];
        const s = scorer(cand, obs);
        scores[scorerNames[i]] = Number.isFinite(s) ? s : 0;
        if (!Number.isFinite(s) || s <= 0) {
          score = 0;
          vetoedBy = scorerNames[i];
          break;
        }
        score *= s;
      }
      rows.push({ verb: cand.verb, args: cand.args, scores, final: score, vetoedBy });
      if (score > 0) ranked.push({ cand, score });
    }
    if (ranked.length === 0) {
      log('utility-brain: no candidate scored > 0', { selfId: obs?.selfId });
      const actions = opts.fallback ? [opts.fallback] : [];
      if (debug) debug({ candidates: rows, scorerNames, winner: actions[0] ?? null, fallback: true });
      return actions;
    }
    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const av = `${a.cand.verb}:${JSON.stringify(a.cand.args)}`;
      const bv = `${b.cand.verb}:${JSON.stringify(b.cand.args)}`;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    const chosen = ranked.slice(0, topK).map((e) => e.cand);
    if (debug) debug({ candidates: rows, scorerNames, winner: chosen[0] ?? null, fallback: false });
    return chosen;
  }

  return { id: opts.id, step };
}

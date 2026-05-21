/**
 * DeterministicBrain — emit a fixed action list for any Observation.
 *
 * The smoke-test brain. Useful for: integration tests, "this character
 * is offline" placeholders, baseline comparisons against UtilityBrain.
 *
 * Usage:
 *
 *   const idle = createDeterministicBrain({
 *     id: 'idle',
 *     actions: [{ verb: 'idle', args: {} }],
 *   })
 *
 *   const wave = createDeterministicBrain({
 *     id: 'wave',
 *     actions: (obs) => obs.trigger.kind === 'spawn'
 *       ? [{ verb: 'wave', args: {} }]
 *       : [],
 *   })
 */

/**
 * @typedef {Object} DeterministicBrainOpts
 * @property {string} id
 * @property {
 *   | { verb: string, args: Record<string, unknown> }[]
 *   | ((obs: import('../../types.js').Observation) => { verb: string, args: Record<string, unknown> }[])
 * } actions
 */

/**
 * @param {DeterministicBrainOpts} opts
 * @returns {import('../../types.js').Brain}
 */
export function createDeterministicBrain(opts) {
  if (!opts?.id) throw new Error('createDeterministicBrain: id required');
  if (opts.actions == null) {
    throw new Error('createDeterministicBrain: actions (array or fn) required');
  }
  async function step(obs) {
    if (typeof opts.actions === 'function') {
      const out = opts.actions(obs);
      return Array.isArray(out) ? out : [];
    }
    return opts.actions;
  }
  return { id: opts.id, step };
}

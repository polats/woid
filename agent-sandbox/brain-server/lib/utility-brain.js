// First-slice utility brain. Hard-coded for one rule: low energy → sit.
// Phase 1.5 swaps in the real utility brain from src/lib/harness/.

/**
 * @param {object} obs   Observation (see CONTRACT.md)
 * @returns {{actions: object[], trace: object}}
 */
export function step(obs) {
  const energy = obs?.needs?.energy ?? 100;

  if (energy < 50) {
    return {
      actions: [{ verb: 'sit', args: { object_id: 'chair_1' } }],
      trace: {
        ts: Date.now(),
        // No LLM turn — utility-only. Inspector renders "no LLM turn".
        turns: [],
        reasoning: `energy=${energy} < 50 → sit`,
      },
    };
  }

  return {
    actions: [],
    trace: { ts: Date.now(), turns: [], reasoning: `energy=${energy} OK, idle` },
  };
}

/**
 * Colony brain factory — wires the harness UtilityBrain with Colony's
 * candidate generator and scorers. One brain per dupe; brains are
 * pure (no state of their own — everything comes from the observation).
 */

import { createUtilityBrain } from '../harness/impls/brains/UtilityBrain.js';
import {
  candidatesFor,
  scoreNeedPressure,
  scoreProximity,
  scoreSkillMatch,
  scoreStressRelief,
} from './utility.js';

/**
 * @param {string} dupeId
 * @returns {import('../harness/types.js').Brain}
 */
export function createColonyBrain(dupeId) {
  return createUtilityBrain({
    id: `colony-utility-${dupeId}`,
    candidates: candidatesFor,
    scorers: [
      scoreNeedPressure,
      scoreProximity,
      scoreSkillMatch,
      scoreStressRelief,
    ],
    topK: 1,
    fallback: { verb: 'idle', args: {} },
  });
}

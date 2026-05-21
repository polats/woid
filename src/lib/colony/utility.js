/**
 * Colony utility scoring — pure functions used by the UtilityBrain.
 *
 * Each scorer takes a candidate `{ verb, args }` and an Observation,
 * returns a non-negative number. The brain multiplies all scorer
 * outputs; a single 0 vetoes the candidate.
 *
 * Tuning principles (matches the Sims smart-object pattern and the
 * Dave Mark utility-theory talks):
 *
 *   - Hard veto via 0 score (wrong type of tile; no resource available).
 *   - Soft pressure via [0.1, 1.0] multipliers.
 *   - One-knob-per-consideration: easier to debug than blended scores.
 */

import { manhattan, NEED_LOW_THRESHOLD } from './world.js';

const PROXIMITY_DECAY = 0.08;   // per Manhattan tile
const MIN_PROXIMITY_SCORE = 0.15;

/** Higher when this candidate matches the most-pressing need. */
export function scoreNeedPressure(cand, obs) {
  const needs = obs?.needs ?? {};
  const energy = needs.energy ?? 100;
  const food = needs.food ?? 100;

  switch (cand.verb) {
    case 'sleep':
      if (energy >= 95) return 0.05;
      return clamp01((100 - energy) / 60);
    case 'eat':
      if (food >= 95) return 0.05;
      return clamp01((100 - food) / 60);
    case 'mine': {
      // Mining is a "produce ore" action — only attractive when basic
      // needs aren't critical. The closer to depleted, the lower the
      // score, so the dupe doesn't grind ore while starving.
      const worst = Math.min(energy, food);
      if (worst < NEED_LOW_THRESHOLD) return 0.1;
      return 0.7;
    }
    case 'idle':
      return 0.05;
    default:
      return 0.3;
  }
}

/** Higher when the candidate target is closer to the dupe. */
export function scoreProximity(cand, obs) {
  const pos = obs?.game?.pos;
  if (!pos) return 1;
  const { x, y } = cand.args ?? {};
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 1;
  const dist = manhattan(pos, { x, y });
  // Soft falloff: 0 distance → 1.0, 10 distance → 0.36, 20+ → floor.
  return Math.max(MIN_PROXIMITY_SCORE, Math.exp(-PROXIMITY_DECAY * dist));
}

/** Mining-only: scale by skill (50% → 0.75; 100% → 1.0). */
export function scoreSkillMatch(cand, obs) {
  if (cand.verb !== 'mine') return 1;
  const mining = obs?.game?.skills?.mining ?? 0;
  return 0.5 + (mining / 100) * 0.5;
}

/** Stress-driven priority: high stress amplifies rest/eat candidates. */
export function scoreStressRelief(cand, obs) {
  const stress = obs?.game?.stress ?? 0;
  if (stress < 50) return 1;
  if (cand.verb === 'sleep') return 1 + (stress - 50) / 50;
  if (cand.verb === 'eat') return 1 + (stress - 50) / 100;
  if (cand.verb === 'mine') return Math.max(0.2, 1 - (stress - 50) / 100);
  return 1;
}

/**
 * Build the list of candidate verbs for a dupe given the current
 * observation. Reads pre-computed game fields from the adapter to
 * avoid re-scanning the grid.
 */
export function candidatesFor(obs) {
  const out = [];
  const game = obs?.game ?? {};

  for (const dep of game.oreDeposits ?? []) {
    if ((dep.tile?.ore ?? 0) > 0) {
      out.push({ verb: 'mine', args: { x: dep.x, y: dep.y } });
    }
  }
  for (const bed of game.beds ?? []) {
    out.push({ verb: 'sleep', args: { x: bed.x, y: bed.y } });
  }
  for (const kit of game.kitchens ?? []) {
    if ((game.resources?.food ?? 0) > 0) {
      out.push({ verb: 'eat', args: { x: kit.x, y: kit.y } });
    }
  }
  // Always allow idle so the brain has a fallback.
  out.push({ verb: 'idle', args: {} });
  return out;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

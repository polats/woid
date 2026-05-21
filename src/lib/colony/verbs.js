/**
 * Colony verbs — the action vocabulary the brain emits.
 *
 * Five verbs, each with a JSON-Schema-ish args definition (matches the
 * harness Verb type from src/lib/harness/types.js), a prompt line for
 * future LLM brains, and a handler that returns a list of Effects.
 *
 * Effects are applied by the store; verbs themselves are pure. This
 * keeps the verb registry trivially testable and makes the entire
 * action surface inspectable from a single file.
 *
 * Movement is teleport (per tasks/490-colony-game-scaffold.md non-goals).
 * Multi-tick travel is a follow-up if/when it becomes interesting.
 */

import { clampNeed, tileAt } from './world.js';

/**
 * @typedef {import('../harness/types.js').Verb} Verb
 * @typedef {import('../harness/types.js').Effect} Effect
 */

const STRESS_RELIEF_ON_REST = 8;
const FOOD_FROM_KITCHEN = 35;
const ENERGY_FROM_BED = 60;

export const VERBS = /** @type {Record<string, Verb<any, any>>} */ ({
  move_to: {
    name: 'move_to',
    args: {
      x: { type: 'number', required: true },
      y: { type: 'number', required: true },
    },
    prompt: 'Walk to (x, y). Teleports in this build; future versions will pathfind.',
    handler: (actor, args, _world) => {
      const x = Number(args.x), y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return [{ kind: 'perceive', target: actor.id, event: { kind: 'action_rejected', verb: 'move_to', reason: 'invalid_args', ts: Date.now() } }];
      }
      return [
        { kind: 'mutate', apply: (w) => { w.dupes[actor.id].pos = { x, y }; w.dupes[actor.id].currentAction = 'walking'; w.dupes[actor.id].lastVerb = 'move_to'; } },
        { kind: 'perceive', target: '*nearby*', event: { kind: 'movement', who_id: actor.id, who_name: actor.name, x, y, ts: Date.now() } },
      ];
    },
  },

  mine: {
    name: 'mine',
    args: {
      x: { type: 'number', required: true },
      y: { type: 'number', required: true },
    },
    prompt: 'Mine ore from a deposit at (x, y). The dupe steps to the tile and extracts one ore unit.',
    handler: (actor, args, world) => {
      const x = Number(args.x), y = Number(args.y);
      const tile = tileAt(world, x, y);
      if (!tile || tile.type !== 'ore_deposit') {
        return [{ kind: 'perceive', target: actor.id, event: { kind: 'action_rejected', verb: 'mine', reason: 'not_an_ore_deposit', ts: Date.now() } }];
      }
      const remaining = Math.max(0, (tile.ore ?? 0) - 1);
      return [
        {
          kind: 'mutate',
          apply: (w) => {
            w.dupes[actor.id].pos = { x, y };
            w.dupes[actor.id].currentAction = 'mining';
            w.dupes[actor.id].lastVerb = 'mine';
            w.resources.ore = (w.resources.ore ?? 0) + 1;
            // Drain a little energy from work
            const e = w.dupes[actor.id].needs.energy;
            w.dupes[actor.id].needs.energy = clampNeed(e - 0.5);
            // Bump skill very slowly
            const sk = w.dupes[actor.id].skills.mining ?? 0;
            w.dupes[actor.id].skills.mining = Math.min(100, sk + 0.1);
            // Deplete the deposit
            const key = `${x},${y}`;
            if (remaining <= 0) delete w.grid.tiles[key];
            else w.grid.tiles[key] = { ...tile, ore: remaining };
          },
        },
        { kind: 'perceive', target: '*nearby*', event: { kind: 'colony:ore_mined', x, y, by_id: actor.id, by_name: actor.name, ts: Date.now() } },
      ];
    },
  },

  eat: {
    name: 'eat',
    args: {
      x: { type: 'number', required: true },
      y: { type: 'number', required: true },
    },
    prompt: 'Go to a kitchen tile at (x, y) and eat. Raises food need; consumes stockpiled food.',
    handler: (actor, args, world) => {
      const x = Number(args.x), y = Number(args.y);
      const tile = tileAt(world, x, y);
      if (!tile || tile.type !== 'kitchen') {
        return [{ kind: 'perceive', target: actor.id, event: { kind: 'action_rejected', verb: 'eat', reason: 'not_a_kitchen', ts: Date.now() } }];
      }
      if ((world.resources.food ?? 0) <= 0) {
        return [{ kind: 'perceive', target: actor.id, event: { kind: 'action_rejected', verb: 'eat', reason: 'no_food', ts: Date.now() } }];
      }
      return [
        {
          kind: 'mutate',
          apply: (w) => {
            w.dupes[actor.id].pos = { x, y };
            w.dupes[actor.id].currentAction = 'eating';
            w.dupes[actor.id].lastVerb = 'eat';
            const before = w.dupes[actor.id].needs.food;
            w.dupes[actor.id].needs.food = clampNeed(before + FOOD_FROM_KITCHEN);
            w.resources.food = Math.max(0, (w.resources.food ?? 0) - 5);
          },
        },
        { kind: 'perceive', target: '*nearby*', event: { kind: 'colony:ate', x, y, by_id: actor.id, by_name: actor.name, ts: Date.now() } },
      ];
    },
  },

  sleep: {
    name: 'sleep',
    args: {
      x: { type: 'number', required: true },
      y: { type: 'number', required: true },
    },
    prompt: 'Go to a bed at (x, y) and rest. Restores energy; relieves stress.',
    handler: (actor, args, world) => {
      const x = Number(args.x), y = Number(args.y);
      const tile = tileAt(world, x, y);
      if (!tile || tile.type !== 'bed') {
        return [{ kind: 'perceive', target: actor.id, event: { kind: 'action_rejected', verb: 'sleep', reason: 'not_a_bed', ts: Date.now() } }];
      }
      return [
        {
          kind: 'mutate',
          apply: (w) => {
            w.dupes[actor.id].pos = { x, y };
            w.dupes[actor.id].currentAction = 'sleeping';
            w.dupes[actor.id].lastVerb = 'sleep';
            const beforeE = w.dupes[actor.id].needs.energy;
            w.dupes[actor.id].needs.energy = clampNeed(beforeE + ENERGY_FROM_BED);
            const beforeS = w.dupes[actor.id].stress;
            w.dupes[actor.id].stress = Math.max(0, beforeS - STRESS_RELIEF_ON_REST);
          },
        },
        { kind: 'perceive', target: '*nearby*', event: { kind: 'colony:slept', x, y, by_id: actor.id, by_name: actor.name, ts: Date.now() } },
      ];
    },
  },

  idle: {
    name: 'idle',
    args: {},
    prompt: 'Wait. Used when nothing pressing is happening.',
    handler: (actor, _args, _world) => {
      return [
        { kind: 'mutate', apply: (w) => { w.dupes[actor.id].currentAction = 'idle'; w.dupes[actor.id].lastVerb = 'idle'; } },
      ];
    },
  },
});

export const VERB_LIST = Object.freeze(Object.values(VERBS));

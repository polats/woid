/**
 * Top-level verb catalog — what the LLM brain picks from.
 *
 * Derived from OBJECT_TYPES (every affordance becomes a verb operating on
 * an object_id) plus standalone verbs that don't target an object (say).
 *
 * Canonical home: agent-sandbox/woid-core/registry/verbs.js.
 */

import { OBJECT_TYPES } from "./objects.js";

/**
 * Standalone verbs — not tied to a specific object affordance. Add new
 * non-object verbs here.
 */
export const STANDALONE_VERBS = {
  say: {
    name: "say",
    args: {
      text: { type: "string", required: true, desc: "short utterance, 1-2 sentences max, in-character" },
      to:   { type: "string", required: false, desc: "character_id of intended listener; omit for general remark" },
    },
    prompt: "Speak out loud. Use to greet, react, or banter with another character. Keep it short and in-character.",
    preconditions: ["someone_to_hear"],
  },
  drink: {
    name: "drink",
    args: {
      object_id: { type: "string", required: true, desc: "holdable mug/cup/glass to pick up and sip from" },
    },
    prompt: "Pick up a mug or cup and drink from it. Use when slightly hungry or just to take a moment.",
    preconditions: ["object_holdable", "adjacent"],
  },
};

/**
 * One verb declaration per (object-type, affordance) pair, deduped by name.
 * If multiple object types offer the same verb (e.g. sit on chair OR bed),
 * the verb takes object_id and the brain picks the specific instance.
 */
function deriveObjectVerbs() {
  const verbs = {};
  for (const [typeName, type] of Object.entries(OBJECT_TYPES)) {
    for (const affordance of type.affordances ?? []) {
      const name = affordance.verb;
      if (verbs[name]) {
        // Verb already declared by an earlier object type — append the type
        // to the prompt so the brain knows it applies to multiple things.
        verbs[name].prompt += ` Also works on ${type.description}.`;
        continue;
      }
      verbs[name] = {
        name,
        args: {
          object_id: { type: "string", required: true, desc: "smart-object instance id" },
        },
        prompt: `${name.charAt(0).toUpperCase() + name.slice(1)} on ${type.description}.`,
        preconditions: affordance.preconditions ?? [],
        // pass-through for clients that want to inspect the affordance
        affordance: { object_type: typeName, ...affordance },
      };
    }
  }
  return verbs;
}

export const VERBS = {
  ...deriveObjectVerbs(),
  ...STANDALONE_VERBS,
};

export function listVerbs() {
  return Object.values(VERBS);
}

// LLM-driven brain step. Given an Observation + Character (with persona + verb catalog),
// returns Action[] and a trace entry.

import { chatJson } from './llm/index.js';
import { listVerbs } from './verbs.js';

const BRAIN_SYSTEM = (persona, verbsBlock) => `You are an NPC in a Sims-flavored life-sim. Decide what this character does next based on their needs, perception, and personality.

You are:
- Name: ${persona.name ?? 'Unknown'}
- About: ${persona.about ?? '(no bio)'}
- Vibe: ${persona.vibe ?? ''}

Available verbs:
${verbsBlock}

Behavior rules:
- Stay in-character at all times.
- Prefer social actions when another character is nearby and has spoken to you (check world.nearby_characters.last_said_to).
- If someone said something to you last tick, respond — use "say" with "to": their id.
- Otherwise tend to needs: low energy → sit; nothing pressing → "actions": [].
- Reference the OTHER character by their name (world.nearby_characters[].name), not their id.
- Keep "say" lines short (max 1-2 sentences) and idiosyncratic — match your vibe.

Reply with JSON only:
{
  "reasoning": "1-2 sentences explaining your choice.",
  "actions": [ { "verb": "<name>", "args": { ... } } ]
}

ONE action per step. No markdown.`;

function verbsBlock() {
  return listVerbs().map((v) => {
    const argsStr = Object.entries(v.args ?? {})
      .map(([k, spec]) => `${k}:${spec.type}${spec.required ? '' : '?'}`).join(', ');
    return `- ${v.name}(${argsStr}) — ${v.prompt}`;
  }).join('\n');
}

/**
 * @param {object} obs    Observation (CONTRACT.md §Observation)
 * @param {object} character  brain-server's Character record (has identity, etc.)
 * @returns {Promise<{actions:object[], trace:object}>}
 */
export async function step({ obs, character }) {
  const persona = {
    name: character.identity?.name,
    about: character.identity?.about,
    vibe: character.identity?.vibe,
  };
  const system = BRAIN_SYSTEM(persona, verbsBlock());

  const obsSummary = {
    needs: obs.needs ?? {},
    moodlets: obs.moodlets ?? [],
    recent_perception: (obs.perception ?? []).slice(-5),
    trigger: obs.trigger,
    // sbox stuffs world snapshot (nearby_objects, position, etc.) into game.
    // Pass-through so the brain knows what's actually around.
    world: obs.game ?? {},
  };
  const userPrompt = `Current state:\n${JSON.stringify(obsSummary, null, 2)}\n\nDecide your next action. Use ONLY object_ids that appear in world.nearby_objects. If nothing meaningful to do, return "actions": [].`;

  const startTs = Date.now();
  const { text, usage, model } = await chatJson({
    systemPrompt: system,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 600,
    temperature: 0.8,
  });
  const ms = Date.now() - startTs;

  let parsed;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return {
      actions: [],
      trace: {
        ts: Date.now(),
        turns: [
          { role: 'system', text: system, tokens: usage?.input ?? 0 },
          { role: 'user', text: userPrompt },
          { role: 'assistant', text, tokens: usage?.output ?? 0, ms },
        ],
        reasoning: `(parse failed: ${e.message})`,
        usage, model,
      },
    };
  }

  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  return {
    actions,
    trace: {
      ts: Date.now(),
      turns: [
        { role: 'system', text: system, tokens: usage?.input ?? 0 },
        { role: 'user', text: userPrompt },
        { role: 'assistant', text, tokens: usage?.output ?? 0, ms },
      ],
      reasoning: parsed.reasoning ?? '',
      usage, model,
    },
  };
}

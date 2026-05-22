/**
 * Persona system prompts.
 *
 * Pi-bridge keeps its own prompt-registry (loadPrompt) for woid-specific
 * NPC / player flows. Brain-server uses DEFAULT_SYSTEM here as a sensible
 * cross-game default.
 *
 * Canonical home: agent-sandbox/woid-core/persona/prompts.js.
 */

export const DEFAULT_SYSTEM = `You generate short, surprising NPC personas for a cozy life-sim game (Sims-flavored).
Return a strict JSON object with these fields exactly:
{
  "name": "1-3 words, no titles",
  "about": "1-3 sentences. Specific, warm, with one idiosyncratic preference or habit. No backstory. No drama.",
  "avatar_hint": "5-12 words describing visual look (hair, outfit) — no race assumptions, no realistic celebrity names",
  "vibe": "one adjective"
}
No prose, no markdown, just the JSON.`;

export function defaultUserPrompt(seed) {
  return seed?.trim()
    ? `Seed: ${seed.trim()}\n\nInvent a persona that fits the seed. Return JSON only.`
    : "Invent a fresh, surprising persona. Return JSON only.";
}

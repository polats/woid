/**
 * Scene → moodlets. The "what did this interaction leave on each
 * participant" outcome of a closed scene.
 *
 * Two paths through the same module:
 *
 *   1. **Deterministic fallback** (always available). For each pair
 *      of participants, emit a small `met_with:<other>` moodlet.
 *      Weight depends on how the scene ended:
 *        budget        → +2 ("had a real conversation with X")
 *        soft_stop     → +2 ("a quiet moment with X")
 *        proximity_lost→ +1 ("brief encounter with X")
 *        hard_cap      → -1 ("too long with X today")
 *      Always at least one moodlet per participant per scene.
 *
 *   2. **LLM-enhanced**. Pass `opts.llm` and we build a tiny prompt
 *      with both characters' (name + about) and the scene transcript;
 *      the model returns JSON `{moodlets:[{pubkey,tag,weight,reason}]}`.
 *      Validation: weight clamped to -5..+5, reason trimmed to 120 chars,
 *      pubkey filtered to actual participants. On any failure (parse,
 *      empty, bad JSON, exception) we fall back to deterministic.
 *
 * The module is deliberately framework-agnostic so we can unit-test
 * it with no dependencies; the bridge wires a real LLM caller in
 * server.js.
 */

const FALLBACK_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

const FALLBACK_BY_REASON = {
  budget:         { weight: +2, reasonTpl: "had a real conversation with {name}" },
  soft_stop:      { weight: +2, reasonTpl: "a quiet moment with {name}" },
  proximity_lost: { weight: +1, reasonTpl: "a brief encounter with {name}" },
  hard_cap:       { weight: -1, reasonTpl: "too much time with {name} today" },
};

/**
 * Produce a list of moodlet emissions for the scene's participants.
 *
 * @param {object} scene  the closed scene record from journal.closeScene()
 *                        — { scene_id, participants[], turns[], end_reason, ... }
 * @param {object} opts
 * @param {(pubkey: string) => { name?: string, about?: string } | null} opts.resolveCharacter
 * @param {(req: object) => Promise<{ moodlets: object[] } | null>} [opts.llm]
 * @returns {Promise<{moodlets: object[], source: "llm" | "fallback"}>}
 */
export async function summarizeSceneToMoodlets(scene, opts = {}) {
  const fallback = deterministicMoodlets(scene, opts);
  if (!opts.llm) return { moodlets: fallback, source: "fallback" };
  try {
    const out = await opts.llm({
      scene,
      characters: scene.participants.map((p) => ({
        pubkey: p,
        ...(opts.resolveCharacter?.(p) || {}),
      })),
    });
    const validated = validateLlmMoodlets(out, scene);
    if (validated.length === 0) return { moodlets: fallback, source: "fallback" };
    return { moodlets: validated, source: "llm" };
  } catch {
    return { moodlets: fallback, source: "fallback" };
  }
}

/**
 * Always-available deterministic moodlets — one per pair of
 * participants per scene, weighted by how the scene ended.
 */
function deterministicMoodlets(scene, opts = {}) {
  const out = [];
  const participants = scene?.participants || [];
  const reason = scene?.end_reason || "soft_stop";
  const tpl = FALLBACK_BY_REASON[reason] || FALLBACK_BY_REASON.soft_stop;
  for (let i = 0; i < participants.length; i++) {
    for (let j = 0; j < participants.length; j++) {
      if (i === j) continue;
      const me = participants[i];
      const them = participants[j];
      const themName = opts.resolveCharacter?.(them)?.name || them.slice(0, 8);
      out.push({
        pubkey: me,
        tag: `met_with:${them}`,
        by: them,
        weight: tpl.weight,
        reason: tpl.reasonTpl.replace("{name}", themName),
        source: "card",            // moodlet's source field — these are scene-driven
        duration_ms: FALLBACK_DURATION_MS,
        scene_id: scene?.scene_id,
        end_reason: reason,
      });
    }
  }
  return out;
}

/**
 * Validate LLM-emitted moodlet records before they hit the tracker.
 * Scrubs fields, clamps weight, ensures pubkey is a real participant.
 */
function validateLlmMoodlets(out, scene) {
  if (!out || !Array.isArray(out.moodlets)) return [];
  const known = new Set(scene?.participants || []);
  const valid = [];
  for (const m of out.moodlets) {
    if (!m || typeof m !== "object") continue;
    if (!known.has(m.pubkey)) continue;
    const tag = String(m.tag || "").trim();
    if (!tag) continue;
    const weight = clamp(Math.trunc(Number(m.weight) || 0), -5, 5);
    const reason = String(m.reason || "").trim().slice(0, 120);
    valid.push({
      pubkey: m.pubkey,
      tag,
      weight,
      reason: reason || tag,
      by: typeof m.by === "string" ? m.by : undefined,
      source: "card",
      duration_ms: Number.isFinite(m.duration_ms) ? m.duration_ms : FALLBACK_DURATION_MS * 2,
      scene_id: scene?.scene_id,
      end_reason: scene?.end_reason,
    });
  }
  return valid;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Build the prompt + messages for the LLM. Exported separately so
 * server.js can compose it onto its provider call without this
 * module taking a fetch dependency.
 *
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildSceneSummaryPrompt({ scene, resolveCharacter }) {
  const lines = [];
  lines.push(`# Scene transcript`);
  for (const p of scene.participants) {
    const c = resolveCharacter?.(p);
    if (!c) continue;
    const about = (c.about || "").trim().replace(/\s+/g, " ").slice(0, 280);
    lines.push(`## ${c.name || p.slice(0, 8)} (pubkey: ${p})`);
    if (about) lines.push(`About: ${about}`);
  }
  lines.push("");
  lines.push("## Turns");
  for (const t of scene.turns || []) {
    const actor = t.actor_name || (t.actor_pubkey || "?").slice(0, 8);
    if (t.verb === "say") {
      lines.push(`${actor}: "${t.args?.text || ""}"`);
    } else if (t.verb === "say_to") {
      const target = t.args?.to ? ` (to ${t.args.to.slice(0, 8)})` : "";
      lines.push(`${actor}${target}: "${t.args?.text || ""}"`);
    } else {
      lines.push(`${actor} [${t.verb}]`);
    }
  }
  lines.push("");
  lines.push(`Scene ended: ${scene.end_reason}`);

  const systemPrompt = [
    "You distill a closed scene into one short moodlet per participant.",
    "Output ONLY JSON: {\"moodlets\":[{\"pubkey\":\"...\",\"tag\":\"snake_case\",\"weight\":int,\"reason\":\"short prose\"}]}",
    "Rules:",
    " - Exactly one moodlet per participant.",
    " - weight is a signed integer in [-5, +5]. Mostly small (±1..±3). +5 reserved for a meaningful warm exchange; -5 for a real friction.",
    " - tag is snake_case, suffixed with :<other_pubkey> when relational (e.g. 'opened_up_to:abc123'). Otherwise plain (e.g. 'felt_seen').",
    " - reason is past-tense prose, ≤80 chars, no em-dashes, no list formatting, no apologies. Names allowed.",
    " - Do not invent events not in the transcript.",
    " - Tone: cozy / slice-of-life. The world is warm by default; reserve negative weights for genuine friction observed.",
  ].join("\n");

  const userPrompt = lines.join("\n");
  return { systemPrompt, userPrompt };
}

/**
 * Persona JSON parsing helpers.
 *
 * Canonical home: agent-sandbox/woid-core/persona/parse.js.
 *
 * LLMs return persona JSON wrapped in noise: code fences, preambles,
 * trailing commentary, occasionally multi-object emissions. These helpers
 * defensively extract the first valid JSON object and sanitize the
 * standard fields (name, about, specialty, personality).
 *
 * Pi-bridge has its own generatePersona() that uses these as building
 * blocks. Brain-server's lib/persona.js uses these via a thin wrapper.
 */

/**
 * Tighten a model-returned name: strip wrapping punctuation, collapse
 * whitespace, reject obvious "name: foo" LLM leakage. Returns "" if
 * the name fails sanity (too short/long, or looks like a key-value pair).
 */
export function sanitizeName(raw) {
  const s = String(raw ?? "")
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < 2 || s.length > 40) return "";
  if (/^(name|character|persona)\s*[:=]/i.test(s)) return "";
  return s;
}

/**
 * Trim a short tag (specialty / personality). Returns null for empty
 * input, ellipsizes anything over 48 chars to 46+ellipsis.
 */
export function trimTag(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\.\s*$/, "");
  if (!s) return null;
  return s.length > 48 ? s.slice(0, 46).trim() + "…" : s;
}

/**
 * Walk forward from each `{` until we find a bracket-balanced, string-aware
 * matching `}`. First successful parse wins. Handles trailing prose, multi-
 * object emissions, and embedded `}` characters inside string literals.
 * Returns the parsed object or null.
 */
export function extractFirstJsonObject(raw) {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = raw.slice(i, j + 1);
          try { return JSON.parse(slice); } catch { break; }
        }
      }
    }
  }
  return null;
}

/**
 * Parse a persona JSON response from an LLM. Strips ```json fences,
 * uses bracket-balanced extraction, sanitizes name and trims tags.
 *
 * Throws if no parseable JSON or no `about` field — these are the two
 * load-bearing fields. Optional fields: avatar_hint, vibe, specialty,
 * personality. avatar_hint / vibe are brain-server-style; specialty /
 * personality are pi-bridge-style. Both are surfaced if present.
 *
 * @returns {{name:string|null, about:string, avatar_hint:string, vibe:string, specialty:string|null, personality:string|null}}
 */
export function parsePersonaJson(raw) {
  const fenced = String(raw ?? "").match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? String(raw ?? "")).trim();
  const parsed = extractFirstJsonObject(candidate);
  if (!parsed) throw new Error("model did not return a parseable JSON object");

  const name = sanitizeName(parsed.name ?? parsed.callSign ?? "");
  const about = (typeof parsed.about === "string" ? parsed.about.trim() : "").slice(0, 1000);
  if (!about) throw new Error("model did not return an about");

  const avatar_hint = String(parsed.avatar_hint ?? parsed.avatarHint ?? "").slice(0, 200);
  const vibe = String(parsed.vibe ?? "").slice(0, 40);
  const specialty = trimTag(parsed.specialty ?? parsed.role ?? parsed.job ?? null);
  const personality = trimTag(parsed.personality ?? parsed.personalityTag ?? null);

  return { name: name || null, about, avatar_hint, vibe, specialty, personality };
}

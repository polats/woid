/**
 * Storyteller HTTP snapshot projection — the data shape powering the
 * /storyteller/snapshot endpoint. Lives in its own module so it's
 * unit-testable without spinning up express. Pure function: deps in,
 * JSON-shaped object out.
 */

export function phaseForSimSlot(slot) {
  if (slot === "morning") return "opening";
  if (slot === "evening" || slot === "night") return "closing";
  return "ambient";
}

export function storytellerCardView(card) {
  return {
    id: card.id,
    phase: card.phase,
    weight: card.weight,
    intensity_min: card.intensity_min,
    intensity_max: card.intensity_max,
    once_per_session: !!card.once_per_session,
    exhaustible: !!card.exhaustible,
    cooldown_sim_min: card.cooldown_sim_min ?? 0,
    description: card.description || "",
    action_count: Array.isArray(card.actions) ? card.actions.length : 0,
  };
}

/**
 * @param {{
 *   director: { snapshot: () => object },
 *   cardLoader: { listAll: () => object[] },
 *   slot: string | undefined,
 *   characterCount: number,
 *   loadErrors?: object[],
 * }} deps
 */
export function buildStorytellerSnapshot({ director, cardLoader, slot, characterCount, loadErrors = [] }) {
  const dirSnap = director.snapshot();
  const phase = phaseForSimSlot(slot);
  const all = cardLoader.listAll();
  const cards = all.map((c) => {
    const view = storytellerCardView(c);
    const inIntensityWindow = c.intensity_min <= dirSnap.intensity && dirSnap.intensity <= c.intensity_max;
    const firedOnce = dirSnap.fired_this_session.includes(c.id);
    const exhausted = dirSnap.exhausted.includes(c.id);
    view.in_intensity_window = inIntensityWindow;
    view.fired_this_session = firedOnce;
    view.exhausted = exhausted;
    // First-failing filter, in the same order the director walks them.
    // Null = eligible.
    let blocked_by = null;
    if (c.phase !== phase) {
      blocked_by = { kind: "phase", message: `phase is "${c.phase}", current is "${phase}"` };
    } else if (firedOnce && c.once_per_session) {
      blocked_by = { kind: "once_per_session", message: "already fired this session" };
    } else if (exhausted) {
      blocked_by = { kind: "exhausted", message: "exhausted" };
    } else if (!inIntensityWindow) {
      const where = dirSnap.intensity < c.intensity_min ? "below min" : "above max";
      blocked_by = {
        kind: "intensity",
        message: `intensity ${dirSnap.intensity.toFixed(2)} is ${where} (window ${c.intensity_min}–${c.intensity_max})`,
      };
    }
    view.blocked_by = blocked_by;
    view.eligible_now = blocked_by === null;
    return view;
  });
  return {
    intensity: dirSnap.intensity,
    target: dirSnap.target,
    queue_depth: dirSnap.queue_depth,
    fired_this_session: dirSnap.fired_this_session,
    current_slot: slot,
    current_phase: phase,
    character_count: characterCount,
    cards,
    load_errors: loadErrors,
  };
}

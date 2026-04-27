import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStorytellerSnapshot, phaseForSimSlot, storytellerCardView } from "../storyteller/snapshot.js";

function fakeDirector(over = {}) {
  return {
    snapshot: () => ({
      intensity: 0.5,
      target: 0.4,
      queue_depth: 0,
      fired_this_session: [],
      exhausted: [],
      cooldowns: 0,
      ...over,
    }),
  };
}

function fakeLoader(cards) {
  return { listAll: () => cards };
}

function makeCard(over = {}) {
  return {
    id: "c1",
    phase: "ambient",
    weight: 1,
    intensity_min: 0,
    intensity_max: 1,
    once_per_session: false,
    exhaustible: false,
    cooldown_sim_min: 0,
    actions: [{ type: "Wait" }],
    description: "",
    ...over,
  };
}

// ── phaseForSimSlot ──

test("phaseForSimSlot: morning → opening", () => {
  assert.equal(phaseForSimSlot("morning"), "opening");
});

test("phaseForSimSlot: evening/night → closing", () => {
  assert.equal(phaseForSimSlot("evening"), "closing");
  assert.equal(phaseForSimSlot("night"), "closing");
});

test("phaseForSimSlot: anything else → ambient", () => {
  assert.equal(phaseForSimSlot("afternoon"), "ambient");
  assert.equal(phaseForSimSlot(undefined), "ambient");
  assert.equal(phaseForSimSlot(null), "ambient");
});

// ── storytellerCardView ──

test("storytellerCardView: projects core fields + action count", () => {
  const v = storytellerCardView(makeCard({
    id: "test", weight: 5, intensity_min: 0.2, intensity_max: 0.8,
    once_per_session: true, cooldown_sim_min: 30, description: "desc",
    actions: [{ type: "Wait" }, { type: "Wait" }, { type: "Wait" }],
  }));
  assert.equal(v.id, "test");
  assert.equal(v.weight, 5);
  assert.equal(v.intensity_min, 0.2);
  assert.equal(v.intensity_max, 0.8);
  assert.equal(v.once_per_session, true);
  assert.equal(v.cooldown_sim_min, 30);
  assert.equal(v.description, "desc");
  assert.equal(v.action_count, 3);
});

test("storytellerCardView: missing optional fields default cleanly", () => {
  const v = storytellerCardView({ id: "x", phase: "ambient", actions: [] });
  assert.equal(v.cooldown_sim_min, 0);
  assert.equal(v.description, "");
  assert.equal(v.once_per_session, false);
  assert.equal(v.action_count, 0);
});

// ── buildStorytellerSnapshot ──

test("snapshot: passes through director scalars + slot/phase", () => {
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.42, target: 0.6, queue_depth: 3 }),
    cardLoader: fakeLoader([]),
    slot: "morning",
    characterCount: 2,
  });
  assert.equal(r.intensity, 0.42);
  assert.equal(r.target, 0.6);
  assert.equal(r.queue_depth, 3);
  assert.equal(r.current_slot, "morning");
  assert.equal(r.current_phase, "opening");
  assert.equal(r.character_count, 2);
  assert.deepEqual(r.cards, []);
});

test("snapshot: card eligible when phase matches + intensity in window", () => {
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.5 }),
    cardLoader: fakeLoader([makeCard({ id: "ok", phase: "ambient", intensity_min: 0.2, intensity_max: 0.8 })]),
    slot: "afternoon",
    characterCount: 1,
  });
  const c = r.cards[0];
  assert.equal(c.eligible_now, true);
  assert.equal(c.in_intensity_window, true);
});

test("snapshot: card not eligible when intensity out of window", () => {
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.9 }),
    cardLoader: fakeLoader([makeCard({ id: "low", intensity_max: 0.4 })]),
    slot: "afternoon",
    characterCount: 1,
  });
  const c = r.cards[0];
  assert.equal(c.eligible_now, false);
  assert.equal(c.in_intensity_window, false);
});

test("snapshot: card not eligible when phase mismatches current slot", () => {
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.5 }),
    cardLoader: fakeLoader([makeCard({ id: "amb", phase: "ambient" })]),
    slot: "morning",   // → opening, not ambient
    characterCount: 1,
  });
  assert.equal(r.cards[0].eligible_now, false);
  assert.equal(r.cards[0].in_intensity_window, true);  // still flag separately
});

test("snapshot: once_per_session card marked ineligible after fire", () => {
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.5, fired_this_session: ["once"] }),
    cardLoader: fakeLoader([makeCard({ id: "once", phase: "ambient", once_per_session: true })]),
    slot: "afternoon",
    characterCount: 1,
  });
  const c = r.cards[0];
  assert.equal(c.fired_this_session, true);
  assert.equal(c.eligible_now, false);
});

test("snapshot: exhausted card marked ineligible", () => {
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.5, exhausted: ["dead"] }),
    cardLoader: fakeLoader([makeCard({ id: "dead", phase: "ambient", exhaustible: true })]),
    slot: "afternoon",
    characterCount: 1,
  });
  assert.equal(r.cards[0].exhausted, true);
  assert.equal(r.cards[0].eligible_now, false);
});

test("snapshot: blocked_by names the first failing filter (intensity below)", () => {
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.1 }),
    cardLoader: fakeLoader([makeCard({ id: "x", phase: "ambient", intensity_min: 0.5 })]),
    slot: "afternoon",
    characterCount: 1,
  });
  const c = r.cards[0];
  assert.equal(c.eligible_now, false);
  assert.equal(c.blocked_by.kind, "intensity");
  assert.match(c.blocked_by.message, /below min/);
});

test("snapshot: blocked_by names phase mismatch over intensity", () => {
  // When multiple filters fail, blocked_by reports the first the
  // director would check — phase comes before intensity.
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.0 }),
    cardLoader: fakeLoader([makeCard({ id: "x", phase: "ambient", intensity_min: 0.5 })]),
    slot: "morning",  // → opening, not ambient
    characterCount: 1,
  });
  assert.equal(r.cards[0].blocked_by.kind, "phase");
});

test("snapshot: blocked_by once_per_session when fired", () => {
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.5, fired_this_session: ["once"] }),
    cardLoader: fakeLoader([makeCard({ id: "once", phase: "ambient", once_per_session: true })]),
    slot: "afternoon",
    characterCount: 1,
  });
  assert.equal(r.cards[0].blocked_by.kind, "once_per_session");
});

test("snapshot: eligible card has blocked_by = null", () => {
  const r = buildStorytellerSnapshot({
    director: fakeDirector({ intensity: 0.5 }),
    cardLoader: fakeLoader([makeCard({ id: "x", phase: "ambient" })]),
    slot: "afternoon",
    characterCount: 1,
  });
  assert.equal(r.cards[0].eligible_now, true);
  assert.equal(r.cards[0].blocked_by, null);
});

test("snapshot: load_errors pass through unchanged", () => {
  const errs = [{ path: "/x.json", error: "JSON parse" }];
  const r = buildStorytellerSnapshot({
    director: fakeDirector(),
    cardLoader: fakeLoader([]),
    slot: "morning",
    characterCount: 0,
    loadErrors: errs,
  });
  assert.deepEqual(r.load_errors, errs);
});

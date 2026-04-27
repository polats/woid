import { test } from "node:test";
import assert from "node:assert/strict";
import { createCardLoader, validateCard } from "../storyteller/cards.js";

function inMemoryFs() {
  const store = new Map();
  function existsSync(p) {
    if (store.has(p)) return true;
    const prefix = p.endsWith("/") ? p : p + "/";
    for (const k of store.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }
  return {
    _store: store,
    existsSync,
    readdirSync: (p) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const set = new Set();
      for (const k of store.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const entry = rest.split("/")[0];
        if (entry) set.add(entry);
      }
      return [...set];
    },
    statSync: (p) => {
      // It's a directory iff it has children but no exact key.
      if (store.has(p)) return { isDirectory: () => false };
      return { isDirectory: () => true };
    },
    readFileSync: (p) => store.get(p) ?? "",
  };
}

function fsWith(files) {
  const fs = inMemoryFs();
  for (const [path, content] of Object.entries(files)) {
    fs._store.set(path, content);
  }
  return fs;
}

const validCard = {
  id: "morning-kettle",
  phase: "ambient",
  weight: 8,
  intensity_min: 0,
  intensity_max: 0.4,
  trigger: { any: ["slot == 'morning'"] },
  roles: { early_riser: { select: "random_character" } },
  actions: [
    { type: "EmitMoodlet", target: "early_riser", tag: "had_quiet_morning", weight: 3, reason: "alone with the kettle" },
  ],
  description: "Someone is the first one up; the kitchen is quiet.",
};

test("loadAll: loads a valid card from disk", () => {
  const fs = fsWith({ "/cards/morning-kettle.json": JSON.stringify(validCard) });
  const loader = createCardLoader({ cardsPath: "/cards", fs });
  const r = loader.loadAll();
  assert.equal(r.loaded, 1);
  assert.equal(r.errors.length, 0);
  const card = loader.get("morning-kettle");
  assert.equal(card.phase, "ambient");
  assert.equal(card.weight, 8);
  assert.equal(card.intensity_max, 0.4);
});

test("loadAll: walks subdirectories", () => {
  const fs = fsWith({
    "/cards/opening/arrival.json": JSON.stringify({ ...validCard, id: "arrival", phase: "opening" }),
    "/cards/ambient/morning-kettle.json": JSON.stringify({ ...validCard, id: "morning-kettle" }),
    "/cards/closing/journal.json": JSON.stringify({ ...validCard, id: "journal", phase: "closing" }),
  });
  const loader = createCardLoader({ cardsPath: "/cards", fs });
  const r = loader.loadAll();
  assert.equal(r.loaded, 3);
});

test("loadAll: skips non-.json files", () => {
  const fs = fsWith({
    "/cards/morning-kettle.json": JSON.stringify(validCard),
    "/cards/README.md": "this is a readme",
    "/cards/draft.txt": "not a card",
  });
  const loader = createCardLoader({ cardsPath: "/cards", fs });
  const r = loader.loadAll();
  assert.equal(r.loaded, 1);
});

test("loadAll: reports JSON parse errors but continues", () => {
  const fs = fsWith({
    "/cards/good.json": JSON.stringify({ ...validCard, id: "good" }),
    "/cards/bad.json": "{ this is { not valid json",
  });
  const loader = createCardLoader({ cardsPath: "/cards", fs });
  const r = loader.loadAll();
  assert.equal(r.loaded, 1);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /JSON parse/);
});

test("loadAll: rejects duplicate ids", () => {
  const fs = fsWith({
    "/cards/a.json": JSON.stringify({ ...validCard, id: "dupe" }),
    "/cards/b.json": JSON.stringify({ ...validCard, id: "dupe" }),
  });
  const loader = createCardLoader({ cardsPath: "/cards", fs });
  const r = loader.loadAll();
  assert.equal(r.loaded, 1);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /duplicate/);
});

test("listByPhase filters", () => {
  const fs = fsWith({
    "/cards/a.json": JSON.stringify({ ...validCard, id: "a", phase: "opening" }),
    "/cards/b.json": JSON.stringify({ ...validCard, id: "b", phase: "ambient" }),
    "/cards/c.json": JSON.stringify({ ...validCard, id: "c", phase: "ambient" }),
  });
  const loader = createCardLoader({ cardsPath: "/cards", fs });
  loader.loadAll();
  assert.equal(loader.listByPhase("opening").length, 1);
  assert.equal(loader.listByPhase("ambient").length, 2);
  assert.equal(loader.listByPhase("cliffhanger").length, 0);
});

// ── validateCard ──

test("validateCard: missing id", () => {
  const r = validateCard({ phase: "ambient", actions: [{ type: "Wait" }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /id/);
});

test("validateCard: invalid phase", () => {
  const r = validateCard({ id: "x", phase: "weird", actions: [{ type: "Wait" }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /phase/);
});

test("validateCard: actions must be non-empty array", () => {
  const r = validateCard({ id: "x", phase: "ambient", actions: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /actions/);
});

test("validateCard: rejects unknown action type", () => {
  const r = validateCard({ id: "x", phase: "ambient", actions: [{ type: "TeleportToMars" }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /TeleportToMars/);
});

test("validateCard: rejects GoTo with no matching Label", () => {
  const r = validateCard({
    id: "x", phase: "ambient",
    actions: [{ type: "Wait" }, { type: "GoTo", target: "ghost" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /GoTo target "ghost"/);
});

test("validateCard: accepts GoTo with matching Label", () => {
  const r = validateCard({
    id: "x", phase: "ambient",
    actions: [
      { type: "Label", name: "loop" },
      { type: "Wait" },
      { type: "GoTo", target: "loop" },
    ],
  });
  assert.equal(r.ok, true);
});

test("normalisation: defaults applied", () => {
  const fs = fsWith({
    "/cards/a.json": JSON.stringify({
      id: "minimal",
      phase: "ambient",
      actions: [{ type: "Wait" }],
    }),
  });
  const loader = createCardLoader({ cardsPath: "/cards", fs });
  loader.loadAll();
  const card = loader.get("minimal");
  assert.equal(card.weight, 1);
  assert.equal(card.intensity_min, 0);
  assert.equal(card.intensity_max, 1);
  assert.equal(card.once_per_session, false);
  assert.equal(card.exhaustible, false);
  assert.equal(card.cooldown_sim_min, 0);
  assert.deepEqual(card.trigger, {});
  assert.deepEqual(card.roles, {});
  assert.equal(card.description, "");
});

test("snapshot: counts by phase + carries last errors", () => {
  const fs = fsWith({
    "/cards/a.json": JSON.stringify({ ...validCard, id: "a", phase: "opening" }),
    "/cards/b.json": JSON.stringify({ ...validCard, id: "b", phase: "ambient" }),
    "/cards/bad.json": "garbage",
  });
  const loader = createCardLoader({ cardsPath: "/cards", fs });
  loader.loadAll();
  const snap = loader.snapshot();
  assert.equal(snap.count, 2);
  assert.equal(snap.byPhase.opening, 1);
  assert.equal(snap.byPhase.ambient, 1);
  assert.equal(snap.errors.length, 1);
});

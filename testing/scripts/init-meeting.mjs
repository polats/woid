#!/usr/bin/env node
/**
 * Initialize a deterministic two-character meeting scenario for the
 * playwright e2e harness (or for poking by hand).
 *
 * Creates two test characters with seeded `about` text, spawns them
 * at adjacent tiles in the kitchen, and prints the resulting record
 * as JSON on stdout so downstream tests can reuse them.
 *
 *   $ node testing/scripts/init-meeting.mjs
 *   { "characters": [ ... ], "rooms": 6 }
 *
 * Env knobs:
 *   BRIDGE_URL              — defaults to http://localhost:13457
 *   KEEP_TEST_CHARACTERS    — if "1" the script's printed `cleanup`
 *                             will be a no-op (use when iterating)
 */

const BRIDGE = process.env.BRIDGE_URL || "http://localhost:13457";

const TEST_PERSONAS = [
  {
    nameSeed: "eira",
    about:
      "Eira — a careful baker who likes the apartment to be quiet and warm before anyone else is up. She speaks softly and notices small things first.",
  },
  {
    nameSeed: "felix",
    about:
      "Felix — a restless researcher who keeps strange hours. Sharp, dry, often lost in a thought he hasn't finished out loud.",
  },
];

async function fetchJSON(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${url} → HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

async function createTestCharacter(persona) {
  const name = `${persona.nameSeed}-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`;
  const c = await fetchJSON(`${BRIDGE}/characters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await fetchJSON(`${BRIDGE}/characters/${c.pubkey}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ about: persona.about }),
  });
  return c;
}

async function spawn(pubkey, x, y) {
  return fetchJSON(`${BRIDGE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, x, y }),
  });
}

async function main() {
  // Bridge sanity.
  const h = await fetch(`${BRIDGE}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!h?.ok) {
    console.error(JSON.stringify({ error: "bridge not reachable", bridge: BRIDGE }));
    process.exit(1);
  }

  // Pick two adjacent tiles in the kitchen so they're scene-mates the
  // moment they both spawn. The schedule mover would also bring them
  // together over time, but we want a deterministic test fixture.
  const { rooms } = await fetchJSON(`${BRIDGE}/rooms`);
  const kitchen = rooms.find((r) => r.id === "kitchen");
  if (!kitchen) {
    console.error(JSON.stringify({ error: "kitchen room missing" }));
    process.exit(1);
  }
  // Two tiles inside the kitchen, diagonally adjacent → within scene radius.
  const x1 = kitchen.x + 2, y1 = kitchen.y + 1;
  const x2 = kitchen.x + 3, y2 = kitchen.y + 2;

  const created = [];
  for (const p of TEST_PERSONAS) {
    const c = await createTestCharacter(p);
    created.push({ ...c, _seed: p });
  }

  const spawned = [
    await spawn(created[0].pubkey, x1, y1),
    await spawn(created[1].pubkey, x2, y2),
  ];

  const out = {
    bridge: BRIDGE,
    rooms: rooms.length,
    kitchen: { id: kitchen.id, x: kitchen.x, y: kitchen.y, w: kitchen.w, h: kitchen.h },
    characters: created.map((c, i) => ({
      pubkey: c.pubkey,
      name: c.name,
      about: c._seed.about,
      agentId: spawned[i].agentId,
      x: i === 0 ? x1 : x2,
      y: i === 0 ? y1 : y2,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

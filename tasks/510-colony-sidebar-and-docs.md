---
name: Colony — sidebar route + harness onboarding docs (HARNESS.md, integrating.md)
description: Wire Colony into the woid sidebar, ship the two harness docs (≤2 pages each), and update top-level README. Acceptance: a clean clone produces a runnable Colony in the sidebar, and a stranger can write a "wave" adapter in 30 minutes from integrating.md.
status: done
order: 510
epic: harness
depends_on: [470, 480, 490, 500]
---

Phase 3 of the agent harness plan. See **[docs/design/agent-harness.md §6 / Phase 3](../docs/design/agent-harness.md#phase-3--sidebar--docs-510)** for plan context.

This is the surfacing card. Colony works ([#490](490-colony-game-scaffold.md), [#500](500-colony-utility-ai.md)); now it goes into the sidebar with the rest of woid's games, and the harness gains its public-facing docs so external OSS adopters can use it.

The two docs are deliberately short. **The reference implementations are the real documentation.** `colony/adapter.js` is the canonical example; the docs point at it and explain what each interface contract requires.

## Deliverables

- `woid.config.json` — add `features.colony: true`.
- Sidebar route registration for `#/colony` (follow the pattern used by `#/shelter` and `#/agent-sandbox` — likely in `src/App.jsx` or the sidebar component).
- Sidebar entry with name "Colony" and a short description.
- `src/lib/harness/docs/HARNESS.md` (≤2 pages):
  - 1 paragraph intro: what the harness is, what it isn't.
  - The four interfaces, one paragraph each, with a code stub.
  - A small ASCII diagram of how Observation flows into Brain and Actions flow out.
  - "See `src/lib/colony/adapter.js` for a complete example."
  - Link to [docs/research/agent-harness-2026.md](../../../docs/research/agent-harness-2026.md) for the research justification.
- `src/lib/harness/docs/integrating.md` (≤2 pages):
  - "You want to add agents to your game. Here's how, in 30 minutes."
  - Step 1: define your `Verb`s (link to `colony/verbs.js`).
  - Step 2: implement `GameAdapter.observe()` and `.schedule()` (link to `colony/adapter.js`).
  - Step 3: pick a Brain (link to `UtilityBrain`) and attach one per character.
  - Step 4: wire the tick loop.
  - Optional Step 5: ship a `skill/` bundle for BYO-agent players ([#520](520-colony-skill-bundle.md)).
  - A complete copy-pasteable "Hello World" adapter that emits one `wave` verb.
- Top-level `README.md` — add Colony to the demos list. Update the "What's inside" section to mention the harness library.
- `src/lib/colony/README.md` — one paragraph: "Colony is the reference greenfield implementation of the harness. See [docs/design/agent-harness.md](../../../docs/design/agent-harness.md) for the design."

## Acceptance

- A clean clone of woid runs `npm install && npm run dev`, opens `http://localhost:5173`, clicks "Colony" in the sidebar, sees 4 dupes working on the tile grid.
- A reader of `integrating.md` who has not touched woid before produces a working "wave" adapter in ≤30 minutes (timed manually with a friend if needed).
- `README.md` mentions the harness library in the "What's inside" section.
- The two docs are ≤2 pages each (≤80 lines of body content, not counting code blocks).

## Non-goals

- A separate npm package for the harness. Fork-friendly is enough for now; npm-publishable is a deferred hook (§7 of the plan).
- An "AI characters explained" philosophy doc. The reference impls carry that weight.
- Updating Shelter or Sims sidebar entries. Their routes already exist.
- A full API reference. The four interfaces have inline JSDoc; that's the API reference.

## Risk notes

- **Doc length creep.** The temptation is to explain everything in `integrating.md`. The 30-minute "wave" target keeps it honest — anything that doesn't help that goal is cut.
- **Sidebar wiring conflicts.** If `App.jsx` was recently restructured (see git log for recent UI changes), the route-registration path may have moved. Verify against the current Shelter wiring.
- **Mobile responsiveness.** Colony's tile grid on mobile is out of scope; gate the sidebar entry to desktop initially if needed (cf. [#425 mobile-responsive-sandbox (todo)](425-mobile-responsive-sandbox.md)).

## Why this card last

The docs reference Colony as the canonical example. The example must work before the docs can point at it. Estimated 1 day.

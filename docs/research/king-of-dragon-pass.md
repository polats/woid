# King of Dragon Pass / Six Ages — event cards as systemic narrative

A Sharp's *King of Dragon Pass* (1999) and its successor *Six Ages: Ride Like the Wind* (2018) / *Six Ages: Lights Going Out* (2023) are clan-management games set in Greg Stafford's Glorantha. Designed by Robin Laws, David Dunham, and Stafford. They are the canonical example of **hand-authored narrative content selected systemically**, and the answer to a question every emergent-world project eventually asks: *how do you get hand-crafted feel out of a procedural system?*

---

## The card system

Gameplay alternates between turn-based clan administration (sow, herd, raid, build, study magic) and **interactive scenes** delivered as illustrated event cards. KoDP ships ~500 cards; Six Ages titles sit in the 200–300 range each.

A card has:

- **Trigger predicate** — a condition over clan state (low food, high tension with a neighbour, a holy day, an event echo from another card, a season).
- **Setup paragraph(s)** — a written situation. "A traveling weaponthane asks for guest-right..."
- **Choice list** — typically 3–6 options, each with its own short consequence text and a state-mutation effect.
- **Advisor council layer** — your seven advisors (each a named character with traits, e.g. *Bold, Pious, Generous*) speak in-character to recommend an option. The voiced recommendation reflects *their* personality, not strict optimality. Players quickly learn "Asborn always says raid" — and that becomes character.

Selection at runtime is a weighted draw over cards whose triggers match. The same card can fire more than once but typically rate-limits itself (cooldowns + "echoed" follow-up cards that only become eligible after the first fired).

## Why this feels hand-crafted

Three reasons:

1. **Cards are written, not generated.** Every consequence paragraph is human prose. The systemic part is *which card fires when*, not the words you read.
2. **Cards reference *your* state in their text.** "[Advisor] of the [your clan name]..." templating is shallow but well-deployed. A card mentions your last raid target, your founder's name, your tribe.
3. **Cards mutate state in ways future cards check.** A fight with a neighbour clan in card 71 raises a `feud` flag that gates 12 other cards. Players experience this as *consequences propagating*, not a flag being set.

## Heroquesting — the long-arc layer

Above the cards sits **heroquesting**: the player can re-enact a Gloranthan myth with a chosen advisor, choosing actions at story beats. Success grants long-lasting blessings or magical items; failure can permanently maim or kill the questor. A heroquest is effectively a card *chain* with named branches and lasting outcomes.

The architectural point is that a "card" can be either a single beat or a sequence — the same engine handles both.

## The advisor council as personality surface

Advisors don't drive decisions — they *frame* them. Each advisor has a few personality flags (Bold/Cautious, Pious/Pragmatic, Generous/Greedy), and their voiced suggestion in any card reflects those flags. Over a campaign players come to know their advisors as *characters* without any of them being a protagonist. This is the same pattern Battle Brothers uses with traits: durable identity, surfaced at every decision.

## Six Ages refinements

Six Ages tightens the rhythm:

- Per-card **stakes shown up front** (small icons indicating which clan stats the choice will move).
- Tighter season cadence (4 seasons/year vs KoDP's 2 sacred + 2 fire).
- A **god-pact mechanic**: long-term commitments that gate chunks of card pool.
- Better card chaining — outcomes more frequently spawn explicit next-step cards rather than just flag mutations.

## What the design doesn't try to do

- **No NPC autonomy.** The world doesn't simulate individual citizens going about their day. Citizens exist *in cards*, mentioned by name, with consequence — but they're not separately ticking entities.
- **No combat sim.** Battle is a card.
- **No procedural prose.** Every word the player reads was written.

This is the opposite end of the design space from KCD2 or Shadows of Doubt. It works because the game accepts that **simulation isn't story** — story is *selection over written content*, with the simulation deciding what's eligible.

---

## Lessons for an LLM sandbox

- **Hybrid: written cards + LLM filler.** A library of hand-authored narrative beats triggered by world state gives every session a backbone of "designed" moments. The LLM handles the moment-to-moment chatter between beats. Don't expect the LLM to invent dramatic structure on its own — it's good at variation, bad at pacing.
- **Cards are state predicates, not scripts.** Author a card as `{ trigger: world_state_query, body: prose, choices: [{text, effect}] }`. Selection is a small ranker over eligible cards. Adding a card is additive — no central script edits.
- **Echoes and chains.** A card's effect can include "spawn card X eligible in 3 days." Cheap chaining gives perceived continuity ("the weaponthane returned, having found his enemy") without authoring full quests.
- **Advisor voicing maps to our prompt blocks.** Where KoDP voices advisors at decision points, we can voice characters at perception points: each character's response to a fired event reflects their `about` traits — produced by the LLM but seeded with the same trait list every time.
- **The card pool is editable content, not code.** Markdown files in a `cards/` directory, loaded at boot. Same shape as our `tasks/`. The LLM can even propose new cards offline; the human curates.

---

## Sources

- [A Sharp — King of Dragon Pass](http://a-sharp.com/kodp/)
- [A Sharp — Six Ages](https://www.sixages.com/)
- [Wikipedia — King of Dragon Pass](https://en.wikipedia.org/wiki/King_of_Dragon_Pass)
- [Wikipedia — Six Ages](https://en.wikipedia.org/wiki/Six_Ages:_Ride_Like_the_Wind)
- David Dunham, [*"King of Dragon Pass: Game Design"*, Computer Game Developers' Conference 2000](http://a-sharp.com/kodp/cgdc.html)
- Robin D. Laws — [*Hamlet's Hit Points*](https://pelgranepress.com/product/hamlets-hit-points/) (his framework for narrative beats; useful background to KoDP's card cadence)
- [Rock Paper Shotgun — *"Six Ages is a strange and special clan management game"*](https://www.rockpapershotgun.com/six-ages-ride-like-the-wind-review)

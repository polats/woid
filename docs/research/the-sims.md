# The Sims — Smart Objects and Advertised Affordances

The defining architectural choice of *The Sims*, attributed to Will Wright and developed during the "Dollhouse" prototype shown at Stanford in 1996, is that **objects know what they offer; Sims do not know what to do.**

A Sim has no list of activities. Instead, every object on the lot **broadcasts advertisements** of the form `(motive_delta, conditions)`:

- a fridge advertises `+40 hunger`
- a bed advertises `+60 energy`
- a toilet advertises `+20 bladder`
- a *dirty* toilet additionally advertises `+5 room` to anyone with the Neat trait who chooses to clean it

Wright called this **"smart terrain"**. The architecture is also referred to in academic literature as **probabilistic smart terrain** (Sweetser, IEEE).

---

## Motives / Needs

The Sims 1 tracks **8 motives** — Hunger, Bladder, Energy, Comfort, Hygiene, Fun, Social, Room — on a -100..+100 scale. Each motive **decays continuously** at a base rate, with **accelerated decay during related actions** (bladder drops faster while eating; energy drops faster during exercise).

- **Sims 2** added Aspirations (long-term wants/fears) on top.
- **Sims 3** added 60+ traits, each of which can introduce additional motive-like commodities (a Couch Potato actually gets a TV need, not just a TV preference).
- **Sims 4** reduced the core motive count to 6 and rebuilt the system as a tuple of XML tunables.

## Utility scoring

When a Sim is idle, it polls advertisements within range. The advertised score is run through a **non-linear utility curve per motive** — the marginal value of +20 energy is huge when you're at -90 and trivial when you're at +90. Distance, personality multipliers, and trait/buff modifiers further shape the score.

Crucially the Sim does **not** pick the argmax. It picks **stochastically among the top-scoring options**, which is what stops behavior from looking robotic. Robert Zubek's *"Needs-Based AI"* chapter (Game AI Pro / Game Programming Gems) is the canonical written description of this loop.

## The interaction queue

A Sim has a FIFO queue of `Interactions`. Each interaction is itself a small state machine of sub-steps:

1. route to object
2. reserve slot
3. play animation
4. apply motive deltas
5. release slot

"Make food" expands at runtime into "go to fridge → grab ingredients → route to counter → cook → route to table → eat." Routing failures, object interruption, or higher-priority autonomy can pre-empt and re-plan.

## Sims 2 → Sims 4: implementation evolution

Sims 1/2 used **Edith**, a custom visual scripting tool emitting a stack-machine bytecode (`.bhav` files) for interactions.

Sims 4 replaced this entirely with a **Python + XML tuning** stack. The unit of an interaction is now a **SuperInteraction** (a.k.a. `super_affordance`) attached to an object's tuning XML; **Mixer interactions** are short overlays (chat lines, idle gestures) layered onto a running Super. Buffs carry `interaction_category_tags` that gate what an autonomous Sim is allowed to choose.

The **XML Injector** mod ecosystem exists because the game loads SuperAffordance lists at boot from per-object tuning, so injecting an interaction means appending to that list before sealing.

## Tradeoff the Sims team explicitly chose

Putting AI into objects rather than Sims means you can ship new behavior by shipping new objects — expansion packs literally extend the agent's repertoire without touching agent code.

The cost: "smart" emergent behavior is hard to direct. Every new object must carefully tune its advertisements so it doesn't dominate or starve the autonomy market. The Sims 4 tuning XML exists largely to give designers knobs over this.

---

## Lessons for an LLM sandbox

- **The world advertises what's possible.** Every object in our sandbox should expose a list of verbs (`bed.verbs = ["sleep", "make_bed"]`). The LLM picks among them; it never invents verbs.
- **Utility is per-need, with a curve.** Even if the LLM is the picker, surfacing "you're at energy 12; the bed gives +60" in the prompt makes the choice obvious. Don't expect the LLM to recompute utility silently.
- **Stochastic pick from top-K, not argmax.** Same applies to trigger scheduling: don't always pick the most "due" agent to take a turn.
- **Interactions are state machines, not single calls.** "Use the fridge" is a sequence (path → reserve → animate → resolve); the LLM emits intent, the bridge executes the steps.

## Sources

- Mark Brown / GMTK, [*"The Genius AI Behind The Sims"*](https://gmtk.substack.com/p/the-genius-ai-behind-the-sims)
- Robert Zubek, [*"Needs-Based AI"*](http://robert.zubek.net/publications/Needs-based-AI-draft.pdf)
- [Sims 4 Modding Wiki — Super Interaction](https://sims-4-modding.fandom.com/wiki/Super_Interaction)
- [SimsWiki — Interaction Tuning Resource](http://simswiki.info/wiki.php?title=Interaction_Tuning_Resource)
- Don Hopkins, [*"Designing User Interfaces to Simulation Games"*](https://donhopkins.medium.com/designing-user-interfaces-to-simulation-games-bd7a9d81e62d) (Wright's 1996 Stanford talk notes)

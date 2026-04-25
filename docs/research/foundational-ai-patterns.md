# Foundational AI patterns for NPCs

The four architectural patterns that account for ~95% of NPC AI in shipped games. Worth understanding even if your project uses an LLM as the brain — the LLM ends up replacing one layer in one of these stacks, not the whole stack.

---

## Goal-Oriented Action Planning (GOAP)

**Origin:** Jeff Orkin, *"Three States and a Plan: The AI of F.E.A.R."* (GDC 2006). [Paper](https://alumni.media.mit.edu/~jorkin/gdc2006_orkin_jeff_fear.pdf).

Each NPC has:

- A **world state** (boolean / key-value facts: `targetVisible=true`, `weaponLoaded=false`)
- A set of **goals** with priorities (`KillEnemy`, `Patrol`, `Investigate`)
- A pool of **actions**, each with **preconditions** and **effects**

```
Goal: KillEnemy (requires targetDead=true)
        ↓
   [A* over action space]
        ↓
   Plan: Reload → TakeCover → AimAt → Fire
```

The planner runs A* backward from the goal, chaining actions whose effects satisfy preconditions, until it reaches the current world state. F.E.A.R.'s squad behavior — flanking, suppressing fire, retreating to cover — emerged entirely from individual planners reacting to shared world facts.

**Strengths:** Emergent behavior from small action libraries; designers add an action and it auto-composes; debuggable plans.
**Weaknesses:** Doesn't scale to hundreds of actions (A* branching); poor at long-horizon or social behavior; world state must be propositional.
**Use when:** Tactical combat NPCs in moderately constrained worlds.

---

## Behavior Trees (BTs)

**Origin:** Damian Isla, *"Handling Complexity in the Halo 2 AI"* (GDC 2005). [AIIDE writeup](https://www.gamedeveloper.com/programming/gdc-2005-proceeding-handling-complexity-in-the-i-halo-2-i-ai). Alex Champandard's later writing popularized them industry-wide.

A tree of nodes, ticked top-down each frame, returning `Success / Failure / Running`:

```
Root (Selector — first child to succeed wins)
  ├── Sequence: "Flee if hurt"
  │     ├── Condition: HP < 25%
  │     ├── Action: FindCover
  │     └── Action: MoveToCover
  ├── Sequence: "Attack if visible"
  │     ├── Condition: SeesEnemy
  │     ├── Decorator: Cooldown(2s)
  │     └── Action: ShootEnemy
  └── Action: Patrol  (fallback)
```

Core node types: **Sequence** (AND), **Selector** (OR / fallback), **Decorator** (inverter, cooldown, repeat, retry), **Leaf** (action or condition).

**Why it replaced FSMs:** FSMs explode combinatorially — every state needs N-1 transition edges. BTs are *reactive* (each tick re-evaluates from the root, so high-priority branches preempt low ones for free) and *composable* (subtrees are reusable assets). Designers can edit them in graph editors without code changes.

**Weaknesses:** Trees can grow unwieldy; runtime inspectors needed for "why did it pick that branch"; not great at planning multi-step novel sequences (only executes pre-authored shapes); shared blackboards become god objects.
**Use when:** Designer-authored, highly reactive, debuggable behavior — i.e. most action games.

---

## Utility AI

**Origin:** Dave Mark (Intrinsic Algorithm), *"Improving AI Decision Modeling Through Utility Theory"* (GDC 2010), and the book *Behavioral Mathematics for Game AI* (2009). [GDC talk](https://www.gdcvault.com/play/1012410/Improving-AI-Decision-Modeling-Through). Sequel: *"Embracing the Dark Art of Mathematical Modeling"* (GDC 2013).

Each candidate action gets a **score** (typically 0..1) computed from input "considerations" mapped through **response curves** (linear, quadratic, logistic, etc.). The AI picks the highest-scoring action — or weighted-randomly samples from the top-K.

```
Action: "EatSandwich"
  consideration(hunger)        → curve(linear)        = 0.9
  consideration(distanceToFood)→ curve(inv-quadratic) = 0.7
  consideration(inCombat)      → curve(boolean-veto)  = 1.0
  Final utility = 0.9 * 0.7 * 1.0 = 0.63
```

**The Sims** is the canonical case: every object in the world *advertises* its utility ("This bed offers +Sleep, -Hunger") and Sims pick the highest-net-advertisement. Civilization (city/AI), RimWorld (mood/work priorities), Kingdoms of Amalur, and the Total War series all use utility scoring.

**Strengths:** Smooth, gradient-driven decisions; easy to tune by editing curves; handles "soft" priorities and many simultaneous needs naturally; emergent personality via per-NPC curve weights.
**Weaknesses:** Hard to debug ("why did it score 0.41 instead of 0.43?"); requires inspector tooling; can oscillate without cooldown decorators; bad at strict sequencing.
**Use when:** Sims, life sims, autonomous agents with many competing drives.

---

## Hierarchical Task Networks (HTN)

**Origin:** Academic AI planning, Erol/Hendler/Nau 1994. Game adoption: Troy Humphreys, *"Exploring HTN Planners through Example"* in *Game AI Pro* (2013). Used in **Killzone 2/3** (Guerrilla Games — Tim Verweij's GDC 2007/2009 talks), **Transformers: Fall of Cybertron** (High Moon), and **Kingdom Come: Deliverance** (Warhorse — Tomas Plch's talks).

Instead of searching action-space (GOAP), HTN searches *task decompositions*. Designers author **compound tasks** that decompose into ordered **methods** (each a list of subtasks), bottoming out at **primitive tasks** (real actions).

```
Compound: AttackEnemy
  Method 1 (if hasGrenade && enemyClustered):
    → ThrowGrenade → Advance → MopUp
  Method 2 (if hasCover):
    → MoveToCover → SuppressFire → Flank
  Method 3 (default):
    → ChargeAndShoot
```

The planner picks the first method whose preconditions hold, recursively decomposes, and produces a primitive plan.

**HTN vs GOAP:** GOAP discovers plans from action effects; HTN executes designer-authored *recipes* with conditional branches. HTN is more controllable and scales better (smaller search space) but less emergent. GOAP says "figure out how to make targetDead=true"; HTN says "here are 3 ways to attack — pick a viable one."

**Weaknesses:** Authoring burden; rigid if you need novelty; reactivity requires re-planning hooks.
**Use when:** Combat AI in linear/scripted shooters where designers want control with planner flexibility (Killzone), or large-world systemic AI (KCD).

---

## When to use which

- **Behavior Trees** — reactive action-game NPCs where designers need to author and debug. Safe default.
- **Utility AI** — life-sim or many-needs autonomous agents (Sims, RimWorld, colony games).
- **GOAP** — tactical combat with small action sets where emergence matters more than authored choreography.
- **HTN** — directed shooters where designers want planner flexibility but tight control.

The four can be layered. KCD2 wraps GOAP (low) under MBTs (high). RimWorld wraps JobDrivers (low) under a ThinkTree (high). For an LLM-as-brain project, the LLM tends to occupy the upper layer — goal selection — with a deterministic lower layer handling primitive execution.

# Quests and ambitions — character-emanating narrative state

Companion doc to [threads-arcs-loops.md](threads-arcs-loops.md). Two more first-class narrative-state objects, distinct from threads/arcs/loops because they emanate **from the character** rather than from the world or storyteller.

The full taxonomy of narrative state is now five objects:

| | **Thread** | **Arc** | **Loop** | **Ambition** | **Quest** |
|---|---|---|---|---|---|
| Direction | world → character | storyteller → world | pattern observed | character → self | character → world |
| Definition | open dramatic question | scripted multi-card sequence | recurring pattern | long-term life goal | mid-term self-set objective |
| Lifespan | hours–weeks | days | weeks–months | months–life | 1–3 sessions |
| Authoring | storyteller / LLM-detected | storyteller (cards) | detector | character (`about` or self-declared) | character (LLM emits) |
| Turnover | medium | medium | low | very low | high |
| Example | *"Who left the half-finished tea?"* | *"Tomek's tournament"* (3 cards) | *"Marisol's morning kettle"* | *"Cleo wants to finish her novel"* | *"I'll bake bread for everyone tonight"* |
| Inspiration | KoDP, mystery serials | Barotrauma EventSets | Generative Agents | Battle Brothers ambitions, Sims aspirations | Sims 2 wants, Mount & Blade companion arcs |

The reason this distinction matters: **without character-emanating goals, characters only react.** With ambitions and quests, they have *forward motion built into the prompt* — every turn they can ask "what's a step toward my goal?" Threads pull them; ambitions push them. Both are needed for stories.

---

## 1. Why two layers (ambition + quest)

Battle Brothers gives a *company* one ambition with multiple tiers. Sims 2 gave a *Sim* an aspiration plus a constantly-refreshing list of short-term wants/fears. Mount & Blade companions had personal backstory quests that surfaced periodically.

These aren't competing patterns — they're two layers of the same thing:

- **Ambitions** are what the character *wants their life to be*. Slow-moving. Most days don't move them. They're the answer to *"why is this character here?"*
- **Quests** are what the character *plans to do today or this week*. Fast-moving. Multiple in flight. They're the answer to *"what's this character's intention right now?"*

A well-tuned ambition produces 1–3 quests organically as the character pursues it. Quests can also exist without serving an ambition (errands, social initiatives, mood responses).

---

## 2. Schemas

Persistence pattern matches threads/arcs/loops: append-only JSONL under `$WORKSPACE/narrative/{ambitions,quests}.jsonl`.

### 2.1 Ambition

```ts
type Ambition = {
  id: string                  // ulid
  pubkey: string              // character whose ambition this is
  title: string               // ≤60 chars: "finish the novel I started before I moved here"
  summary: string             // 1-2 sentences for prompt + UI
  status: "active" | "stalled" | "achieved" | "abandoned" | "deferred"
  source: "creation" | "self_declared" | "promoted_from_quest"
  created_at: number          // sim-time ms
  updated_at: number
  achieved_at?: number
  category: "creative" | "relational" | "domestic" | "vocational" | "introspective"
  // Optional milestone ladder. Most ambitions stay simple (no milestones)
  // and drift forward through quests served by them.
  milestones?: AmbitionMilestone[]
  // Quests that have served this ambition. Append-only.
  served_by_quests: string[]
  // Threads tied to the ambition (e.g. "Cleo's manuscript" thread).
  related_threads: string[]
}

type AmbitionMilestone = {
  index: number
  title: string               // "first chapter readable"
  status: "pending" | "reached" | "skipped"
  reached_at?: number
  reason?: string
}
```

### 2.2 Quest

```ts
type Quest = {
  id: string
  pubkey: string              // character whose quest this is
  title: string               // ≤60 chars: "bake bread for the new neighbor tonight"
  summary?: string
  status: "pending" | "in_progress" | "completed" | "abandoned" | "expired"
  source: "self_declared" | "card" | "user"   // who created it
  serves_ambition?: string    // ambition id, optional
  created_at: number
  updated_at: number
  due_at?: number             // soft deadline; expires if missed
  completed_at?: number
  steps: QuestStep[]          // optional; many quests are atomic
  // Visible to the LLM in the character turn prompt; moves the
  // character toward the quest by hint, not by force.
  prompt_hint: string         // "you mentioned wanting to do X — consider it today"
}

type QuestStep = {
  index: number
  title: string
  status: "pending" | "done" | "skipped"
  done_at?: number
}
```

---

## 3. Lifecycle

### 3.1 Ambition creation

Three ways:

1. **At character creation** — when the user fills out `about`, the bridge runs a one-shot LLM call: *"Read this character bible. Propose one ambition that fits. Output JSON: { title, summary, category }."* The result is stored as a starter ambition with `source: "creation"`. User can review and edit before confirming.
2. **Self-declared mid-life** — a character can emit a `declare_ambition` action (rare; gated by mood band ∈ {cheerful, steady} and a cooldown of ≥ 7 sim-days between declarations). The ambition surfaces in the next recap.
3. **Promoted from a recurring quest** — if a character has completed quests in the same category 3+ times, the system can promote a synthesized ambition for review.

### 3.2 Quest creation

Most quests come from a new character verb: `set_quest({ title, summary?, due_at?, prompt_hint? })`. The LLM emits this when its line of thinking lands on a small intention. Examples:

- *"I should bake bread for the new neighbor tonight"* → quest with `due_at: end_of_day`.
- *"I want to finish reading that book this week"* → quest with `due_at: +7 days`.

Quests can also be created via cards (`SpawnQuest` action) or by the user (the "give them a small task" UI surface, in #325).

### 3.3 Quest completion

A quest completes via:

1. **Explicit emission** — the character emits `complete_quest(id)` when their action satisfies the quest. The next recap leads with the completion.
2. **Card-driven** — a card with `completes_quest:` in its frontmatter resolves the quest.
3. **User-driven** — via the Stories panel, the user can mark a quest done.
4. **Expiry** — if `due_at` passes without completion, the quest moves to `expired`. An "expired without sting" rule applies: expired quests don't emit negative moodlets unless the character had publicly committed to them in a scene. Most just fade.

### 3.4 Ambition advancement

Ambitions don't have a per-tick advancement step. They advance when:

- A quest with `serves_ambition: <id>` completes → ambition's `served_by_quests[]` grows; if a milestone matches, mark `reached`.
- The recap pipeline detects a milestone-shaped event (an LLM-graded "did this push the ambition forward?" check at session_close).

Ambitions can also **stall**: if no serving quest has fired in N sim-days (default 14), the ambition's status flips to `stalled`. Stalling isn't bad — many real-life ambitions stall and resume — but it surfaces in the UI so the user can intervene if they want. A `revive_ambition` storyteller action exists for arcs that want to nudge.

---

## 4. LLM integration

### 4.1 Prompt block additions

Per character turn, [buildContext.js](../../agent-sandbox/pi-bridge/buildContext.js) gains:

```
Your ambition (active for 23 sim-days):
  Finish the novel I started before I moved here.

Your current quests:
  - Bake bread for the new neighbor tonight (due: today)
  - Finish chapter three this week (due: +5 sim-days)

You may continue with these, set a new one, or set them aside if your mood
or what's happening today calls for something else.
```

Critical wording — **"may"** not "must". Quests are guidance, not obligation. The audience contract is "characters have intentions but aren't railroaded by checklists."

### 4.2 New verbs

Two additions to the verb registry in `gm.js`:

```js
set_quest: {
  args: {
    title: { type: "string", required: true, max: 80 },
    summary: { type: "string", required: false, max: 200 },
    due_at: { type: "string", required: false }, // ISO-ish or relative
    serves_ambition: { type: "string", required: false }, // ambition id
  },
  effects: ["narrative.quest_created"],
  prompt: "declare a small intention for yourself (today, this week, etc.)",
}

complete_quest: {
  args: {
    id: { type: "string", required: true },
    note: { type: "string", required: false, max: 200 },
  },
  effects: ["narrative.quest_completed"],
  prompt: "mark a quest done — you've satisfied what you set out to do",
}
```

Both feed into [#295](../../tasks/295-narrative-state.md)'s narrative store.

### 4.3 Voice and pacing

Three rules to keep this from becoming a checklist game:

1. **Quest declarations should be conversational, not stat-block.** When the LLM emits `set_quest`, the *line* it generates should sound like a person muttering a plan: *"I should bake bread for him tonight."* Not: *"QUEST ACCEPTED: bake bread."*
2. **One quest per turn maximum.** Hard cap so characters don't speed-run intent.
3. **Cap of 3 active quests per character.** A 4th `set_quest` either replaces the oldest or is rejected with a perception event ("you set this aside without saying so").

---

## 5. UI surface

The [Stories panel](threads-arcs-loops.md#41-stories-panel-new) gains two more sub-tabs:

```
[ Threads ] [ Arcs ] [ Loops ] [ Ambitions ] [ Quests ]
```

### 5.1 Ambitions tab

```
┌─ Ambitions (3 active · 1 stalled) ─────────┐
│                                            │
│ Cleo Vega                                  │
│ ◆ Finish the novel I started before I      │
│   moved here                               │
│   creative · 23 days · 4 quests served     │
│                                            │
│ Marisol Asio                               │
│ ◆ Make this apartment feel like a home     │
│   domestic · 12 days · 2 quests served     │
│                                            │
│ Tomek Reyes                                │
│ ⌛ Beat my brother at his own game (stalled │
│   8 days)                                  │
│   vocational · 30 days                     │
│                                            │
└────────────────────────────────────────────┘
```

Click → detail with the served quests timeline + related threads.

### 5.2 Quests tab

```
┌─ Quests (5 in flight · 12 done this week) ─┐
│                                            │
│ Today                                      │
│ □ Cleo: Bake bread for the new neighbor    │
│ □ Marisol: Move the kettle to the kitchen  │
│                                            │
│ This week                                  │
│ □ Cleo: Finish chapter three (+5 days)     │
│                                            │
│ Done recently                              │
│ ✓ Tomek: Catch up with Mara about the trip │
│ ✓ Cleo: Apologize for the music last night │
│                                            │
└────────────────────────────────────────────┘
```

Click → detail with the source perception (the line where the LLM declared it) + completion event.

### 5.3 Inline surfaces

- **Character profile (AgentProfile.jsx Vitals)** — adds a small "Today" sub-section under moodlets listing this character's open quests with tiny status circles.
- **Recap card** — if a quest completed today, the recap UI shows a quest chip; clicking jumps to the quest.

---

## 6. Examples (for the audience)

A handful of well-shaped ambitions and quests for the [vertical slice's](vertical-slice.md) audience:

**Ambitions worth promoting:**

- *Finish the novel I started before I moved here.* (creative)
- *Make this apartment feel like a home — properly mine.* (domestic)
- *Become someone the others come to when something's wrong.* (relational)
- *Get the bakery I keep talking about off the ground.* (vocational)
- *Stop apologizing for things that aren't mine to apologize for.* (introspective)

**Quests worth firing:**

- *Bake bread for the new neighbor tonight.* (relational, due: today)
- *Finally hang the photo I've been carrying around in a drawer.* (domestic, atomic)
- *Catch up with Mara about her trip — properly, not in passing.* (relational, due: +2 days)
- *Try the kettle in three different spots this week.* (domestic, multi-step)
- *Write one paragraph today, even if it's bad.* (creative, daily)

**Anti-patterns** (not in this audience):

- *Defeat the dragon.*
- *Earn 1000¤ by Friday.* (turns it into a checklist game)
- *Win the argument with Bob.* (pegs character into combat-shape conflict)
- *Recover from depression.* (too clinical; instead frame as the milestone-shape "stop apologizing" form)

---

## 7. How quests/ambitions interact with the rest

| Concept | Interaction |
|---|---|
| **Threads** | An ambition can serve a thread (Cleo's *novel* ambition serves the *previous-tenant manuscript* thread if she decides to finish what they left). Cards can plant threads that align with existing ambitions (resonance). |
| **Arcs** | A storyteller arc can include `advances_ambition:` and `advances_quest:` keys to pull a character's intentions forward without authoring per-character. |
| **Loops** | A repeated quest in the same shape (3+ "bake bread for X" quests) can promote a loop ("Cleo bakes when nervous"). Loops can promote to traits ([storyteller.md §6](storyteller.md#6-trait-promotion--turning-mood-into-identity)). |
| **Moodlets** | Completing a quest emits a positive moodlet (`completed_quest:<title>`, +3, fades 24h). Failing/abandoning a publicly-stated quest emits a small negative one. |
| **Recap** | Each session's recap should call out at least one quest completion or ambition milestone if any happened. The "headline" picker prefers ambition milestones > quest completions > thread events > everything else. |
| **Currency** | Quest completion awards a small ¤ bonus (1¤). Ambition milestones award more (3¤). This grounds the [#325](../../tasks/325-shop-currency-unlocks.md) economy in *characters making progress*, not just the player buying things. |

---

## 8. What this isn't

- **Not Skyrim quest log** — there's no "kill 5 wolves" target. Quests are intent, not condition.
- **Not Sims wants/fears slot machine** — the original Sims 2 wants system rotated wants every few hours; ours sticks until completed/abandoned/expired. Stickier = more meaningful.
- **Not gamified self-help** — we're not tracking real user goals. These are *the character's* goals.
- **Not RPG main quest** — there's no "main story" the world is driving toward. Ambitions are *per character*, perpendicular to anything global.

---

## 9. Open questions

1. **Ambition at creation: opt-in or opt-out?** A blank-slate first character with no ambition is fine; one always-defaulted ambition might feel forced. My take: ship as suggested (LLM proposes; user can dismiss); show the ambition slot as empty if dismissed.
2. **Cap on quest creation rate.** One per turn / 3 active is the proposal. Real risk: characters spamming `set_quest` to inflate prompt-context. Need to enforce hard server-side.
3. **Ambition "ladder" UX.** Some ambitions feel like single-step ("hang the photo") and some feel laddered ("publish the novel: chapter 1 → editor → submission"). Optional milestones in the schema cover both. Decision: don't *require* milestones; let LLM/storyteller add them when natural.
4. **Promoting failed quests.** A pattern of repeatedly-set-then-abandoned quests of the same shape ("I'll quit smoking", every Monday) is its own kind of identity surface. Likely promotes to a Loop with status `fading` rather than to a trait.
5. **Cross-character ambitions.** Two characters wanting the same thing — the same kitchen renovation, the same job — is a thread, not two ambitions. Should we let ambitions point at each other? My take: no; thread is the right surface for shared goals.

---

## 10. Implementation order

This isn't a separate task — it's an **additional slice in [#295](../../tasks/295-narrative-state.md)**:

- After threads/arcs/loops schemas land, add `ambitions.jsonl` and `quests.jsonl` to the same narrative store.
- Verb registry additions (`set_quest`, `complete_quest`, optionally `declare_ambition`) wire into `gm.js`.
- Character-creation ambition LLM call wires into the create-character flow in `server.js`.
- Stories panel gains two new sub-tabs.
- Recap pipeline gains a "headline" preference for ambition milestones / quest completions.

Estimated effort: roughly 30% of #295's existing scope, additive. Authoring effort for starter ambitions is light because the LLM proposes them.

# Threads, arcs, loops — narrative state as a first-class surface

Three related-but-distinct narrative-state objects, each with its own lifecycle and UI surface. Together they're how woid keeps the story moving forward and how the player browses what's happening.

> **Sibling doc**: [quests-ambitions.md](quests-ambitions.md) covers the **character-emanating** half of narrative state — ambitions (long-term character goals, Battle Brothers shape) and quests (mid-term self-set objectives, Sims/M&B shape). Threads/arcs/loops are world→character; quests/ambitions are character→world. Both directions are needed for stories: threads pull characters forward, ambitions push them.

This doc is the schema-and-surface companion to [storyteller.md](storyteller.md) and [vertical-slice.md](vertical-slice.md). The taxonomy distinction is the load-bearing idea — collapsing these into a single "story" object is what most LLM-agent demos get wrong.

---

## 1. Taxonomy

| | **Thread** | **Arc** | **Loop** |
|---|---|---|---|
| **One-line definition** | An open dramatic question. | A scripted multi-card sequence. | A recurring pattern the world has settled into. |
| **Example** | *"Who left the half-finished tea?"* | *"Tomek's tournament arc"* (3 cards, 3 sim-days). | *"Marisol's morning kettle ritual"* (recurs daily). |
| **Lifecycle** | open → hinted → active → resolved / abandoned | scheduled → in_progress → completed / aborted | nascent → established → fading / broken |
| **Authoring** | Storyteller-authored or LLM-detected | Storyteller-authored (cards) | LLM-detected from perception stream |
| **Drives narrative?** | Plants questions; pulls user back | Delivers planned beats | Provides texture; surfaces character |
| **Lifespan** | Hours to weeks | Days | Weeks to months |
| **Closeable?** | Yes — by an arc, a card, or LLM judgment | Yes — by completion or abandonment | Yes — by breaking the pattern |
| **Equivalent in fiction** | "What happened to..." | The heist plotline | The running gag |

The three answer different questions:
- **Thread** answers: *what is unresolved in this world?*
- **Arc** answers: *what is the storyteller actively delivering?*
- **Loop** answers: *what does this household do, again and again?*

A single dramatic situation may produce all three. The previous-tenant mystery is a *thread*; the *arc* that resolves it is the package-and-postcard sequence; the *loop* that emerges from it is "Marisol checks the doormat every morning now."

---

## 2. Schemas

All three objects persist as JSONL append-only logs in `$WORKSPACE/narrative/{threads,arcs,loops}.jsonl`, folded into Maps at boot. Mirrors the pattern used by `relationships.jsonl` in [storyteller.md](storyteller.md#8-storage).

### 2.1 Thread

```ts
type Thread = {
  id: string                  // ulid
  title: string               // human, ≤60 chars: "Who left the half-finished tea?"
  summary: string             // 1-2 sentences for the UI
  status: "open" | "hinted" | "active" | "resolved" | "abandoned"
  created_at: number          // sim-time ms
  updated_at: number
  resolved_at?: number
  weight: number              // 0..1; how dramatically central
  category: "mystery" | "romance" | "tension" | "promise" | "curiosity"
  participants: string[]      // pubkeys involved (may be empty for world-level threads)
  related_objects?: string[]  // object ids (the tea cup, the package, …)
  related_threads?: string[]  // thread ids (a thread can spawn sub-threads)
  driving_arc?: string        // arc id currently advancing this thread
  events: ThreadEvent[]       // append-only log
}

type ThreadEvent = {
  at: number
  kind: "planted" | "hinted" | "deepened" | "resolved" | "abandoned"
  source: "card" | "perception" | "user" | "llm"
  source_id: string           // card id / perception id / etc.
  note: string                // 1 sentence: "Mara reacted strangely to the tea."
}
```

### 2.2 Arc

```ts
type Arc = {
  id: string
  title: string               // "Tomek's tournament", "The visiting traveler"
  status: "scheduled" | "in_progress" | "completed" | "aborted"
  created_at: number
  scheduled_for?: number      // sim-time when first card fires
  completed_at?: number
  steps: ArcStep[]
  serves_threads: string[]    // thread ids this arc advances
  closes_threads: string[]    // thread ids this arc resolves on completion
}

type ArcStep = {
  index: number
  card_id: string             // card to fire at this step
  status: "pending" | "fired" | "skipped"
  fired_at?: number
  delay_after?: number        // ms before next step is eligible
  branch_predicate?: string   // optional: "host.has_trait('hospitable')"
}
```

### 2.3 Loop

```ts
type Loop = {
  id: string
  title: string               // "Morning kettle ritual"
  description: string         // 1-2 sentences for UI
  status: "nascent" | "established" | "fading" | "broken"
  created_at: number
  updated_at: number
  participants: string[]      // pubkeys
  pattern: {
    cadence: "daily" | "near-daily" | "weekly" | "irregular"
    canonical_time?: string   // "morning", "evening", "after-meals"
    location?: string         // room id
    trigger_tag?: string      // moodlet/perception tag if any
  }
  observations: number        // count of times the pattern was observed
  last_observed_at: number
  promotion_score: number     // 0..1; ≥ 0.7 → promote to a trait or about-line
}
```

---

## 3. Lifecycle and provenance

### 3.1 Thread creation

Threads are *planted* in three ways:

1. **Storyteller-authored cards** declare `plants_thread:` in frontmatter:
   ```yaml
   plants_thread:
     id: previous-tenant-mystery
     title: "Who left the half-finished tea?"
     category: mystery
     weight: 0.7
   ```
2. **LLM-detected** — at session_close, the recap pipeline scans the day's perception window for unresolved questions ("X mentioned Y but didn't elaborate"). If a question scores ≥ threshold, it's planted as a `status: hinted` thread for review.
3. **User-authored** — the player can pin a question manually from the UI ("I want to remember this thread").

Each thread starts at `status: open` (or `hinted` if LLM-detected) and progresses through the status enum based on Arc activity and card events.

### 3.2 Thread → Arc binding

The Storyteller can *claim* an open thread by scheduling an Arc. The arc's `serves_threads` field binds them. When the arc fires its steps, each step appends a `ThreadEvent` to its served threads with `kind: hinted | deepened`. The arc's final step typically appends `kind: resolved` and sets the thread's `status: resolved`.

Arcs can *also* be ad-hoc — short two-step sequences that don't serve a tracked thread. (Example: an `ambient.shared-window` flavor arc.)

### 3.3 Loop detection

A pattern detector runs at session_close:

```js
// pseudo
for each (perception cluster recurring on similar cadence + participants + location):
  if cluster.observations < 3: continue
  if matches existing loop: bump observations, refresh updated_at
  else: create new loop with status: nascent

for each existing loop:
  if recent gap > 3× cadence: status = fading
  if no observation in 2 weeks: status = broken
  if observations ≥ 7 and consistent: status = established
  if status == established and promotion_score ≥ 0.7: emit "promote-to-trait" candidate
```

Loops feed [storyteller.md §6 trait promotion](storyteller.md#6-trait-promotion--turning-mood-into-identity). The `discovered_morning_quiet` moodlet pattern in the vertical slice is operationalized as a Loop: when the loop reaches `established`, it can promote.

### 3.4 Arc completion and thread resolution

An arc completes when its last `ArcStep.status: fired`. On completion:
- For each `closes_threads` id, the thread's status moves to `resolved`, with a `ThreadEvent { kind: resolved }`.
- A `thread_resolved` perception event is emitted so witnessing characters know.
- The recap LLM is given the resolved thread as a "lead with this" hint for that session's recap.

---

## 4. UI surfaces

### 4.1 Stories panel (new)

A new top-level inspector tab — *Stories* — alongside the existing scenes/inspector tabs. Three sub-tabs:

```
┌─ Stories ──────────────────────────────────┐
│ [ Threads ] [ Arcs ] [ Loops ]             │
│                                            │
│  Threads (3 open · 1 resolved this week)   │
│  ──────────────────────────────────────── │
│  ◉  Who left the half-finished tea?        │
│     active · 5 events · 3 days old         │
│     last: package arrived at the door      │
│                                            │
│  ◯  What is between Mara and Tomek?        │
│     hinted · 2 events · 4 days old         │
│     last: silence over the kettle          │
│                                            │
│  ●  The phone-call voice                   │
│     resolved 2 days ago                    │
│                                            │
└────────────────────────────────────────────┘
```

Status chip:
- ◯ open · hinted (yet to surface)
- ◉ active (currently being advanced)
- ● resolved
- ⊘ abandoned

Click → detail view with the `events[]` log as a chronological timeline, related objects/characters as chips.

### 4.2 Arcs view

```
┌─ Arcs ─────────────────────────────────────┐
│  In progress (2)                           │
│  ────────────────                          │
│  ▶ Tomek's tournament                      │
│    step 2/3 · next card in 1 sim-day      │
│    serves: tomek-confidence-arc            │
│                                            │
│  ▶ The visiting traveler                   │
│    step 1/3 · just started                 │
│                                            │
│  Completed this week (1)                   │
│  ──────────────────────                    │
│  ✓ Tea inheritance                         │
│    closed: previous-tenant-mystery         │
│                                            │
└────────────────────────────────────────────┘
```

### 4.3 Loops view

```
┌─ Loops ────────────────────────────────────┐
│  Established (2)                           │
│  ───────────────                           │
│  ◇ Marisol's morning kettle ritual         │
│    daily · 1A kitchen · 11 observations    │
│                                            │
│  ◇ Carlos's apology-for-apologies          │
│    irregular · 8 observations              │
│                                            │
│  Nascent (3)                               │
│  ─────────                                 │
│  ◇ Tea-time on Tuesdays                    │
│    weekly · 2 observations                 │
│  ...                                       │
└────────────────────────────────────────────┘
```

Click a loop → see the perception events that made it. Click "Promote" → user can manually trigger trait promotion (or revert it).

### 4.4 Inline surfaces

- **Recap card** — when a recap relates to an active thread, the recap UI shows the thread chip below the prose. Click → jumps to thread detail.
- **Character profile** — sidebar shows that character's open threads + active loops they participate in. ("Marisol — 2 open threads, 1 established loop.")
- **Map tooltip** — hovering a tile that's relevant to a thread shows the thread title.

---

## 5. API endpoints

Mirror the existing `GET /scenes` / `GET /scenes/:id` pattern.

```
GET    /threads               → list (filterable by status, participant)
GET    /threads/:id           → full record incl. events
POST   /threads               → user creates (manual pin)
PATCH  /threads/:id           → status update (resolve, abandon)

GET    /arcs                  → list (active + recent)
GET    /arcs/:id
POST   /arcs                  → storyteller schedules
PATCH  /arcs/:id              → step advance, abort

GET    /loops                 → list
GET    /loops/:id
POST   /loops/:id/promote     → user manually promotes to trait

GET    /health/narrative      → counts: open threads, active arcs, loops in each status
```

Sandbox UI polls `/health/narrative` every 10s for the badge counts on the Stories tab.

---

## 6. How the LLM sees them

The system prompt block for a character in a turn now includes:

```
Active threads in your world:
  - Who left the half-finished tea? (Marisol involved)  [3 days · active]
  - What is between Mara and Tomek? (you witnessed)     [4 days · hinted]

Your loops:
  - You make tea before anyone wakes up.                [established]

Currently in an arc: Tomek's tournament (step 2 of 3).
```

This is the **promised-pull** the LLM needs to feel like the character has continuity. Without thread-context in the prompt, characters say "have we discussed this?" because they have no idea they witnessed something.

Threads aren't acted upon directly — the LLM's actions still go through the verb registry. But the LLM's *line choices* will skew toward reference (a glance, an unfinished sentence) when an active thread is in scope. The system prompt should explicitly say so:

> "If a thread is active and relevant, you may reference it obliquely — a glance, a pause, an unfinished sentence. Do not summarize it; the player has read it."

---

## 7. Authoring conventions

### Cards declare what they touch

Frontmatter additions to the card schema (see [storyteller.md §3.2](storyteller.md#32-card)):

```yaml
plants_thread:                # if firing this card creates a thread
  id: ...
  title: ...
  category: ...

advances_thread:              # if firing this card adds an event to existing threads
  - id: previous-tenant-mystery
    kind: deepened
    note: "Marisol drank the tea."

resolves_thread:              # if firing this card closes threads
  - id: previous-tenant-mystery

part_of_arc: tomek-tournament # if this card is a step in an arc
```

### Loops aren't authored — they're *recognized*

Loops are emergent from the perception stream. We don't pre-author loops; we author the *detector heuristics* that recognize them. This is the right side of the [Generative Agents](../research/llm-agent-prior-work.md) pattern — let the LLM-readable history speak for itself.

---

## 8. Open questions

1. **Detection recall**: how aggressive should the LLM-detected thread-planting be? Too aggressive and the Stories panel becomes spam. Too conservative and we miss real questions. Default: only plant LLM-detected threads when the recap pipeline rates them ≥ 0.6 dramatic-weight. Tunable.
2. **Thread-surfacing in prompts**: include all active threads, or only those the character has direct context on? My take: only those where character is in `participants` or has perception events tagged with thread id.
3. **Loop privacy**: do *all* established loops get prompted to all characters, or only loops they're in? Same answer as threads — only their own.
4. **User-authored threads**: should the player be able to *create* a thread that the storyteller then tries to deliver on? This is a fascinating power but risks "the player wrote a query the system can't satisfy." Defer to v2.
5. **Abandoned vs. resolved**: when do we mark a thread `abandoned` vs. let it sit at `open` indefinitely? Heuristic: 14 sim-days of no activity → flag for abandonment in UI; user can confirm or extend.

---

## 9. Implementation order

Lands as a single task ([#295](../../tasks/295-narrative-state.md)) but internally has layered slices:

1. **Schemas + storage** (`narrative.js` module mirroring `objects-registry.js`).
2. **Cards declare thread/arc bindings** — schema additions to card frontmatter, runtime updates to thread/arc state on card fire.
3. **HTTP endpoints** + the `/health/narrative` summary.
4. **Stories panel UI** — Threads tab first; Arcs tab; Loops tab last.
5. **LLM prompt block injection** — once the data is reliable.
6. **Loop detector** — runs at session_close, pattern-matches the perception window.
7. **Trait promotion via loops** — bridges into [storyteller.md §6](storyteller.md#6-trait-promotion--turning-mood-into-identity).

Slices 1–4 are the prototype-able core; 5–7 deepen.

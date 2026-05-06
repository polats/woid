# Agent behaviour — Fallout Shelter & Elder Scrolls Castles

How Bethesda Mobile's two vault-management sims structure dweller
behaviour, schedules, and offline progression. Captured May 2026
while planning the Shelter view's offline data backend.

Bias: 2024–2026 sources. Caveat up front — there's no public
postmortem or technical talk for either title. Save schemas and tick
rates are inferred from datamining + observable behaviour, not from
source. Anything not pinned to a primary citation is community
consensus.

Companion docs:
[shelter-data-backend.md](../design/shelter-data-backend.md),
[fallout-shelter-likes.md](./fallout-shelter-likes.md).

---

## 1. Fallout Shelter (Bethesda, 2015 → still updated)

### Job model is room-assignment, not need-driven

A dweller is bound to one production/training room or unassigned.
Output is gated by their highest-relevant SPECIAL stat (e.g. Strength
for power, Agility for diner) and modulated by happiness; happiness
is largely an **output** of whether they're working a room that
matches their best SPECIAL ([Happiness — Fallout
Wiki](https://fallout.fandom.com/wiki/Happiness_(Fallout_Shelter))).

So "needs" exist (happiness, health, radiation) but they're outputs
of the assignment, not drivers of autonomous goal selection. Idle or
misplaced dwellers "stand around and pretend to be working" and
slowly bleed happiness — there's no idle goal-finder
([Vault dwellers — Fallout
Wiki](https://fallout.fandom.com/wiki/Vault_dwellers_(Fallout_Shelter))).

### Pathing is shallow

Dwellers walk room-to-room via elevators only when you drag them,
when an incident pulls them, or when they leave for a quest /
wasteland. There is no autonomous wandering schedule. The animation
of "working at a station" is purely cosmetic on top of a per-room
production timer.

### Tick is per-room, not per-dweller

Resource production is a countdown on the room (modified by assigned
dwellers' SPECIAL sum and happiness). The clearest exposure of the
tick is the **incident timer**: a hidden global counter that
increments while the app is foregrounded; rush-failure and incident
probability rise as it advances ([FOS FAQ §6 —
Incidents](https://github.com/therabidsquirel/The-Fallout-Shelter-FAQ/wiki/Section-6:-Incidents);
[Rushing — Fallout
Wiki](https://fallout.fandom.com/wiki/Rushing)). Critically:
incidents *can't happen while the game isn't running in the
foreground* — the timer pauses when backgrounded. Strong evidence
the agent layer is a **continuous foreground tick**, not a closed-
form clock formula.

### Family / breeding is per-couple state

Bed assignment of two opposite-sex dwellers triggers
flirt → conception → 3-hour real-time pregnancy timer; lineage is
tracked as parent IDs on the child record. No relationship graph
beyond direct parents (used to block incest).

### Offline progression is partial fast-forward

Resource bars do *not* drain offline, and production "stops as soon
as the next batch is complete." Pure timers (pregnancy, quest
travel, weapon crafting, training) keep advancing using wall-clock
deltas ([Offline Mode Pros and Cons —
Steam](https://steamcommunity.com/app/588430/discussions/0/135513421440986866/);
[GameFAQs
thread](https://gamefaqs.gamespot.com/boards/178144-fallout-shelter/72456999)).
Combat incidents do not occur offline. Closed-form catch-up for
timer-shaped state, no replay of moment-to-moment behaviour.

### Save shape

Saves are AES/Rijndael-CBC-encrypted JSON keyed off `"PlayerData"`
with salt `tu89geji340t89u2`, stored as `Vault{N}.sav`
([decrypt gist](https://gist.github.com/rveitch/13984655dd9401605b94);
[Wasteland editor](https://github.com/zanderlewis/wasteland)).
Decrypted JSON contains `dwellers[]` (with `name`, `gender`,
`stats.stats[]` for SPECIAL, `happiness`, `health`,
`equipedOutfit`, `relations.ascendants`, `pregnant`, etc.),
`vault.rooms[]`, `vault.storage`, and an accumulated-time field on
the vault root. Cloud sync is platform-native (Game Center, Google
Play, Bethesda.net cross-progression); no Bethesda-side authoritative
simulation.

---

## 2. The Elder Scrolls: Castles (Bethesda Mobile, Sept 2024)

Same Bethesda Game Studios mobile team
([VGC, Sept
2024](https://www.videogameschronicle.com/news/bethesda-has-surprise-launched-the-elder-scrolls-castles/);
[Game
Developer](https://www.gamedeveloper.com/business/bethesda-returns-to-mobile-with-the-elder-scrolls-castles)).
Reuses the room/assignment chassis but layers a **wall-clock
dynasty** on top.

### Time scaling: 1 real day = 1 in-game year

Subjects age in real time, marry, bear children, and die — you
must steward succession across generations
([Castles — UESP](https://en.uesp.net/wiki/Castles:Castles);
[GamesRadar
review](https://www.gamesradar.com/games/the-elder-scrolls/the-elder-scrolls-castles-review/)).
Subjects become workable at age 16 and infertile at 65
([Castles:Subjects — UESP](https://en.uesp.net/wiki/Castles:Subjects)).

This makes the in-game day/night cosmetic — gameplay decisions are
pegged to the year clock, not to a diurnal schedule. No public
evidence of per-subject hourly schedules à la Stardew; assignment
is "this subject is on this workstation until you move them," same
as FS.

### Workstations and rooms

Workstations have an efficiency rating from worker count + equipment
([Castles:Workstations summary —
Escapist](https://www.escapistmagazine.com/what-each-workstation-makes-in-elder-scrolls-castles-how-to-unlock-them/)).
Some stations are short-term ("Bed" for procreation, "Temple of
Mara" for marriage) and don't require permanent assignment
([UESP: Bed](https://en.uesp.net/wiki/Castles:Bed)). The Bed has
capacity 2 with compatibility shaped by traits and happiness.

### Traits replace SPECIAL

Each subject has 1–7 traits which condition work proficiency,
romance compatibility, and ruling outcomes
([Bethesda support: Ruler and Subject
Traits](https://help.bethesda.net/app/answers/detail/a_id/67092/);
[Castles:Traits — UESP](https://en.uesp.net/wiki/Castles:Traits)).
Happiness is bifurcated: the Ruler has independent happiness from
Nobles / Commoners.

### Dynasty / succession

When a ruler dies or is exiled, their children become eligible
heirs; you pick from a list
([GameRant marriage
guide](https://gamerant.com/elder-scrolls-castles-marriage-divorce-cheating-guide/)).
Marriage requires unlocking the Shrine of Mara at Dynasty Level 9;
subjects can have one child per in-game year; affairs and
illegitimate children are first-class. Relationship state is
therefore a small graph: spouse, lover(s), children, parents.

### Rulings / decrees — the authored-event layer

Petitioners arrive at the throne presenting a vignette; binary or
trinary choice perturbs resources / morale globally
([Castles:Rulings — UESP](https://en.uesp.net/wiki/Castles:Rulings);
[DotEsports](https://dotesports.com/mobile/news/how-to-make-a-ruling-in-elder-scrolls-castles)).
Each ruling has a per-template **minimum recurrence cooldown** —
UESP entries show 3h, 6h, 1 day
([e.g. SUC009](https://en.uesp.net/wiki/Castles:Rulings/SUC009)).
Events are authored content sampled from a pool with cooldowns,
not pure-procedural.

### Tasks are daily-quest scaffolding

Daily tasks rotate each real day and award Dynasty XP
([Castles:Tasks — UESP](https://en.uesp.net/wiki/Castles:Tasks);
[Castles:Royal
Tasks](https://en.uesp.net/wiki/Castles:Royal_Tasks)) — these are
player-level chores, not per-subject schedules.

### Time when closed

Reviews and player guides describe the year clock as wall-clock
based: subjects keep aging while the app is closed → catch-up is
again **closed-form** (advance ages and timers by `now − lastSave`)
rather than re-simulated. No developer statement; consensus
reading.

### Save / sync

Bethesda's official transfer guide says progress migrates by signing
into the same Google Play / Game Center account on the new device
([Bethesda support
64505](https://help.bethesda.net/app/answers/detail/a_id/64505/))
— platform cloud, not a Bethesda-authoritative server. No Game
Pass cloud save; mobile-only at time of writing.

---

## Cross-cutting answers

- **Tickle vs. schedule.** Both are **tickle-driven on foreground**
  for room production timers, plus **closed-form catch-up** on
  resume for `lastTime + Δ`-shaped state (resources, ages,
  pregnancy, training). Neither computes "what would NPC X be doing
  at clock Y" Animal-Crossing-style — the question is meaningless
  because per-second behaviour is just "stand in assigned room
  playing work animation." FS proves this directly via the
  foreground-only incident timer.
- **Offline reconciliation.** Closed-form, per timer. No replay.
  FS additionally freezes resource drain offline; Castles lets the
  year clock keep running so dynasty pressure persists.
- **Unit of behaviour.** Dweller / subject record + room /
  workstation pointer + a few timers (pregnancy, training, quest
  travel). No BT, no GOAP, no FSM beyond
  `{ idle, working, in-incident, on-quest, pregnant }`-style flags.
  The cheapest model that reads as alive on screen — and how the
  games scale to 200+ agents on a phone.
- **Authored vs. emergent.** FS leans procedural (random wasteland
  encounters, random incidents). Castles' rulings are an explicit
  authored-event library with cooldowns and trait-conditioned
  outcomes — a deliberate addition over FS to give the dynasty
  narrative texture.

---

## Patterns to copy for our Shelter

1. **Assignment > autonomy.** Each agent's "current behaviour" =
   `room_id + role + tiny FSM`. Animations sell life; the sim
   doesn't simulate intent. Reserve the LLM for ruling-style
   authored events and inter-agent dialogue, not desk-sitting.
2. **Closed-form catch-up on resume.** Store `lastTickWallClock`
   and advance per-room timers by elapsed time, capped by a soft
   offline ceiling (FS effectively caps via "stops at next batch
   complete"; we want an explicit cap so unbounded queues don't
   build up).
3. **Foreground-only consequence ticks** (FS's incident timer):
   freeze "bad things" offline so closing the app never feels
   punitive.
4. **Authored event library with cooldowns** (Castles' rulings):
   per-template minimum recurrence + trait gates is a clean way to
   structure LLM prompts — the deterministic layer chooses
   *which* event template fires; the LLM fills in dialogue.
5. **Relationship graph as small structured state** (parents,
   spouse, lovers) — keeps saves diffable JSON and lets the LLM
   read it directly when needed.

---

## Gaps

- No developer talk or postmortem confirms the internal tick rate
  or save schema for Castles.
- FS save schema is reverse-engineered, not officially documented.
- Neither Bethesda Mobile title has a published architecture
  writeup. If we want ground truth, decrypting a Castles save
  (same team, likely similar Unity-JSON shape) is the next move.

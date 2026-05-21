/**
 * Harness interface types — JSDoc-only module (no runtime exports).
 *
 * The four canonical interfaces a game adopting the harness must
 * implement or consume. See:
 *
 *   - docs/design/agent-harness.md §3 (the source-of-truth definitions)
 *   - docs/research/agent-harness-2026.md §6 (why each interface exists)
 *   - src/lib/colony/adapter.js   (reference GameAdapter implementation)
 *   - src/lib/harness/impls/      (reference Brain + IdentityStore impls)
 *
 * Importing this file in JS is a no-op; it just registers the
 * @typedefs so consumer files can `/** @type {Observation} *\/` etc.
 */

// ─── 1. Observation ─────────────────────────────────────────────

/**
 * @typedef {Object} Observation
 * @property {string} selfId          Opaque, game-defined character ID.
 * @property {number} tick            Monotonic; ms-equivalent unit chosen by game.
 * @property {Trigger} trigger        Why the brain is being asked to act right now.
 * @property {PerceptionEvent[]} perception  Typed event log delta since last brain call.
 * @property {Record<string, number>} [needs]      Per-axis values, e.g. { energy: 42 }.
 * @property {Moodlet[]} [moodlets]                Active moodlets from harness/moodlets.
 * @property {string[]} [traits]                   Promoted-trait strings, read-only.
 * @property {Record<string, unknown>} game        Game-specific blob; lazily built.
 */

/**
 * @typedef {(
 *   | { kind: 'spawn' }
 *   | { kind: 'heartbeat' }
 *   | { kind: 'perception', cause: string }
 *   | { kind: 'card', cardId: string }
 *   | { kind: 'player', verb: string }
 * )} Trigger
 */

/**
 * @typedef {Object} PerceptionEvent
 * @property {string} kind   Event kind, e.g. 'speech' | 'colony:job_offered'. Extensible.
 * @property {number} ts     Wall-clock ms when the event happened.
 * Additional kind-specific fields allowed.
 */

/**
 * @typedef {Object} Moodlet
 * @property {string} id
 * @property {string} tag
 * @property {number} weight
 * @property {string} reason
 * @property {number} added_at
 * @property {number|null} expires_at
 * @property {string} [by]
 */

// ─── 2. Brain ───────────────────────────────────────────────────

/**
 * @typedef {Object} Brain
 * @property {string} id              For telemetry / inspector.
 * @property {(obs: Observation) => Promise<Action[]>} step
 * @property {(character: { id: string }) => void} [onAttach]
 * @property {(character: { id: string }) => void} [onDetach]
 */

/**
 * @typedef {Object} Action
 * @property {string} verb            Matches a registered Verb.name in the GameAdapter.
 * @property {Record<string, unknown>} args
 */

// ─── 3. Verb ────────────────────────────────────────────────────

/**
 * @typedef {Object} ArgSchema
 * @property {'string'|'number'|'boolean'|'enum'} type
 * @property {readonly string[]} [values]   For enum.
 * @property {boolean} [required]
 */

/**
 * @template World, Actor
 * @typedef {Object} Verb
 * @property {string} name
 * @property {Record<string, ArgSchema>} args
 * @property {string} prompt          LLM-brain manual line. Required even for non-LLM games — useful in docs.
 * @property {(actor: Actor, args: Record<string, unknown>, world: World) => Effect[]} handler
 */

/**
 * @typedef {(
 *   | { kind: 'mutate',  apply: (world: unknown) => void }
 *   | { kind: 'perceive', target: string | '*nearby*', event: PerceptionEvent }
 * )} Effect
 */

// ─── 4. GameAdapter ─────────────────────────────────────────────

/**
 * @template World
 * @typedef {Object} GameAdapter
 * @property {(characterId: string, world: World, tick: number) => Observation} observe
 * @property {(world: World, tick: number) => string[]} schedule
 * @property {ReadonlyArray<Verb<World, unknown>>} verbs
 * @property {IdentityStore} identity
 */

// ─── 5. IdentityStore (Phase 1 surface; verify/rateLimit deferred) ──

/**
 * @typedef {Object} PortableIdentity
 * @property {string} id
 * @property {string} name
 * @property {string} about
 * @property {string[]} traits
 * @property {string[]} [voiceHints]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} IdentityStore
 * @property {(id: string) => Promise<PortableIdentity | null>} load
 * @property {(identity: PortableIdentity) => Promise<void>} save
 * @property {() => Promise<PortableIdentity[]>} list
 */

// No runtime exports — pure typedef registration.
export {};

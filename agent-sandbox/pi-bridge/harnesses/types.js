/**
 * Harness interface — the pluggable "brain" that turns a user prompt
 * into a set of actions for the bridge to execute. Pi, DirectHarness,
 * ExternalHarness, and any future harness all speak this shape.
 *
 * The bridge owns identity, Nostr publish, Colyseus send, avatar
 * storage, etc. The harness only concerns itself with "take a turn,
 * produce (or commit) actions."
 *
 * Two execution models are both valid:
 *   1. "Return actions" — turn() resolves with a non-empty `actions[]`
 *      and the bridge iterates and executes each (DirectHarness).
 *   2. "Execute and return empty" — the harness performs its own side
 *      effects during the turn (e.g. PiHarness's bash-tool loopback
 *      through /internal/post) and resolves with `actions: []`.
 *
 * The bridge treats both uniformly: it iterates `actions` after every
 * turn and executes anything found there. Harnesses of type (2) leave
 * it empty; harnesses of type (1) populate it.
 *
 * @typedef {'say'|'move'|'state'} ActionType
 *
 * @typedef {Object} SayAction
 * @property {'say'} type
 * @property {string} text
 *
 * @typedef {Object} MoveAction
 * @property {'move'} type
 * @property {number} x
 * @property {number} y
 *
 * @typedef {Object} StateAction
 * @property {'state'} type
 * @property {string} value
 *
 * @typedef {SayAction|MoveAction|StateAction} Action
 *
 * @typedef {Object} TurnUsage
 * @property {number} [input]
 * @property {number} [output]
 * @property {number} [totalTokens]
 * @property {number} [cost]
 *
 * @typedef {Object} TurnResult
 * @property {Action[]} actions  Actions the bridge should execute. [] if harness already committed them.
 * @property {string}  [thinking] Optional agent thinking, for UI.
 * @property {TurnUsage} [usage]  Tokens + cost for this turn.
 * @property {string}  [error]    Non-fatal per-turn error (rate limit, parse failure, etc).
 *
 * @typedef {Object} StartOpts
 * @property {string} agentId        Stable id the bridge uses for this runtime.
 * @property {string} pubkey         Character's hex pubkey.
 * @property {string} systemPrompt   Built by buildContext; pinned per agent.
 * @property {string} provider
 * @property {string} model
 * @property {string} [sessionPath]  Filesystem path for per-agent history, if harness persists.
 * @property {string} [cwd]          Working directory for any child process.
 * @property {Object} [env]          Environment overrides.
 * @property {(ev: HarnessEvent) => void} [onEvent]  Live-stream sink for inspector.
 *
 * @typedef {Object} HarnessEvent
 * @property {'turn_start'|'think'|'action'|'turn_end'|'lifecycle'|'pi'|'error'} kind
 * @property {*} [data]
 *
 * @typedef {Object} HarnessSnapshot
 * @property {string} agentId
 * @property {boolean} running
 * @property {number} turns
 * @property {boolean} [pending]
 * @property {*}     [extra]  Harness-specific diagnostics (e.g. pi pid).
 *
 * @typedef {Object} Harness
 * @property {string} name                                Harness identifier ('pi'|'direct'|'external'|...).
 * @property {(opts: StartOpts) => Promise<void>} start
 * @property {(userTurn: string) => Promise<TurnResult>} turn
 * @property {() => Promise<void>} stop
 * @property {() => HarnessSnapshot} snapshot
 */

// Module exports are purely JSDoc types — runtime is empty.
export const HARNESS_TYPES_VERSION = 1;

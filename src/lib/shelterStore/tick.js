import { resolveAgentState } from './resolver.js'

/**
 * Run one behaviour tick across the whole agent set.
 *
 * Called from the foreground tick loop. Walks every agent, asks
 * `resolveAgentState` for the patch needed, and writes back via
 * `store.updateAgent`. No-op for agents already in steady state.
 *
 * Separate from the clock tick — clock and behaviour run at the
 * same rate but the split keeps the resolver pure / testable.
 */
export function tickAgents(store) {
  const snapshot = store.getSnapshot()
  for (const agent of Object.values(snapshot.agents)) {
    const patch = resolveAgentState(agent, snapshot.simMinutes)
    if (patch) store.updateAgent(agent.id, patch)
  }
}

/**
 * shelterStore — local-first state for the Shelter view.
 *
 * The store owns persisted JSON in localStorage (`woid.shelter.v1`),
 * the sim clock with offline catch-up, and CRUD over agents + rooms.
 * Schedules / event templates land in later phases.
 *
 * See docs/design/shelter-agents.md.
 */
export { createShelterStore, LocalOnlySync } from './store.js'
export {
  SIM_MINUTES_PER_REAL_SECOND,
  OFFLINE_CAP_MIN,
  realMsToSimMinutes,
  simMinutesToAdvance,
  formatSimTime,
  simDay,
} from './clock.js'
export { SCHEDULES, SLOT_ACTIONS, resolveSchedule } from './schedules.js'
export { WALK_DURATION_MIN, PACE_DURATION_MIN, resolveAgentState } from './resolver.js'
export { tickAgents } from './tick.js'

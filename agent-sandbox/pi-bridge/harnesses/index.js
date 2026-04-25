/**
 * Harness factory. Returns a fresh Harness per agent so each has its
 * own state (cannot be shared across agents). Add new harness types
 * here as they land.
 *
 *   pi        — PiHarness (task #135). Wraps pi-pool, coding-agent tools.
 *   direct    — DirectHarness (task #145). One SDK call per turn. TBD.
 *   external  — ExternalHarness (task #150). SSE + remote act POSTs. TBD.
 */

import { createPiHarness } from "./pi.js";
import { createDirectHarness } from "./direct.js";
import { createExternalHarness } from "./external.js";

export const KNOWN_HARNESSES = ["pi", "direct", "external"];
// `direct` is the default brain — call-my-ghost-style: one SDK call
// per turn, JSON out, no subprocess. Existing characters with
// `harness: "pi"` keep that until edited; new spawns without an
// explicit harness fall through to direct.
export const DEFAULT_HARNESS = "direct";

export function createHarness(name = DEFAULT_HARNESS, deps = {}) {
  switch (name) {
    case "pi":
      return createPiHarness(deps);
    case "direct":
      return createDirectHarness(deps);
    case "external":
      return createExternalHarness(deps);
    default:
      throw new Error(`unknown harness "${name}"`);
  }
}

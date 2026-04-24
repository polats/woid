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

export const KNOWN_HARNESSES = ["pi"];
export const DEFAULT_HARNESS = "pi";

export function createHarness(name = DEFAULT_HARNESS, deps = {}) {
  switch (name) {
    case "pi":
      return createPiHarness(deps);
    // case "direct": return createDirectHarness(deps);
    // case "external": return createExternalHarness(deps);
    default:
      throw new Error(`unknown harness "${name}"`);
  }
}

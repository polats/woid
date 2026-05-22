/**
 * Back-compat re-export. Canonical dispatch lives in woid-core/llm/index.js.
 * Pi-bridge's existing call sites `generateJson({ provider, ... })` keep working.
 */
export { generateJson, chatJson, createStubProvider, resolveProvider, llmAvailable, llmProviderInfo }
  from "../../woid-core/llm/index.js";

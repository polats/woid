/**
 * Brain-server's LLM facade. Thin re-export of woid-core's unified dispatch
 * so callers don't reach across the agent-sandbox tree by path.
 */
export {
  chatJson,
  generateJson,
  resolveProvider,
  llmAvailable,
  llmProviderInfo,
} from "../../../woid-core/llm/index.js";

import { overlayApi, useOverlayState } from '../hooks/useOverlayState.js';

/**
 * Floating action button that opens the agent sandbox overlay.
 * Rendered inside each world's `.game-phone-screen` so it sits on
 * the phone mockup at top-left — same position on every world, and
 * still reachable when the app is tested in a mobile viewport.
 */
export default function AgentSandboxFab({ label = 'Agents' }) {
  const { open } = useOverlayState();
  if (open) return null;
  return (
    <button
      type="button"
      className="agent-sandbox-fab"
      onClick={overlayApi.open}
      title="Open agent sandbox (Ctrl/Cmd + ;)"
    >
      <span className="agent-sandbox-fab-icon" aria-hidden="true">◌</span>
      <span className="agent-sandbox-fab-label">{label}</span>
    </button>
  );
}

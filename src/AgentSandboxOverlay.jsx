import { useEffect } from 'react';
import { overlayApi, useOverlayState } from './hooks/useOverlayState.js';
import { useBridgeCharacters } from './hooks/useBridgeCharacters.js';
import SandboxCards from './components/SandboxCards.jsx';

/**
 * Agent sandbox overlay — slim left-side drawer that mounts the same
 * `<SandboxCards />` panel the full sandbox uses, over any world view.
 *
 * Drag a card onto a world's drop target to instantiate. Clicking a
 * card jumps to `#/agent-sandbox` so the AgentDrawer (profile editor,
 * inspector, assets) opens there — the overlay is intentionally just
 * the cards, not a duplicate of the full sandbox.
 */

export default function AgentSandboxOverlay() {
  const { open } = useOverlayState();
  const { characters, refresh } = useBridgeCharacters();

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === ';') { e.preventDefault(); overlayApi.toggle(); return; }
      // Plain "1" toggles the agents overlay — mirrors how backtick
      // toggles the per-world dev console. Suppress while typing so
      // it doesn't fight with text entry.
      if (e.key === '1' && !meta && !e.altKey && !e.shiftKey) {
        const t = e.target;
        const tag = (t?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return;
        e.preventDefault();
        overlayApi.toggle();
        return;
      }
      if (open && e.key === 'Escape') {
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        overlayApi.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <aside className="agent-sandbox-overlay" role="dialog" aria-label="Agent sandbox">
      <header className="agent-sandbox-overlay-head">
        <div className="title">
          <a href="#/agent-sandbox" onClick={overlayApi.close} title="Open the full sandbox">
            <strong>Agent sandbox →</strong>
          </a>
        </div>
        <button
          type="button"
          className="agent-sandbox-overlay-close"
          onClick={overlayApi.close}
          aria-label="Close"
          title="Close (Esc)"
        >×</button>
      </header>
      <div className="agent-sandbox-overlay-body">
        <SandboxCards
          characters={characters}
          onRefresh={refresh}
          inspectedId={null}
          onInspect={(_id, _tab) => {
            // Inspector lives in the full sandbox — jump there and open
            // the AgentDrawer. The overlay stays focused on drag-to-spawn.
            window.location.hash = '#/agent-sandbox';
            overlayApi.close();
          }}
        />
      </div>
    </aside>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import config from '../config.js';
import { useRegisteredWorlds } from '../lib/harness/registry.js';
import { WORLD_META } from '../lib/worldIcons.js';
import { useHashRoute } from '../hooks/useHashRoute.js';

function parseWorldFromHash() {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  if (h === 'game') return 'sims';
  if (h === 'shelter') return 'shelter';
  if (h === 'colony') return 'colony';
  return null;
}

/**
 * SandboxCards — the agents-aside extracted from Sandbox.jsx so the
 * overlay and the full sandbox share the *exact* same panel: tab rail,
 * `+ New`, persona prompt editor, filter strip, and the draggable
 * card list. One source of truth.
 *
 * Drag source semantics are unchanged from the original Sandbox
 * implementation: each card sets `application/x-character-pubkey`
 * on dragstart. Drop targets in every world view read this MIME
 * through the shared `useCharacterDrop` hook.
 *
 * Props:
 *   characters     — bridge roster (parent passes from useBridgeCharacters)
 *   onRefresh      — () => Promise<void>  refresh after +New / Stop
 *   inspectedId    — currently inspected character/agent id (for selected highlight)
 *   onInspect      — (id, tab) => void    emitted on card click
 */
const cfg = config.agentSandbox || {};

export default function SandboxCards({
  characters = [],
  onRefresh,
  inspectedId = null,
  onInspect = () => {},
}) {
  const [sidebarTab, setSidebarTab] = useState('agents');
  const [agentFilter, setAgentFilter] = useState('all');
  const registeredWorlds = useRegisteredWorlds();
  const activeWorld = useHashRoute(parseWorldFromHash);
  const [showSettings, setShowSettings] = useState(false);
  const [spawnError, setSpawnError] = useState(null);

  // Persona prompt editor
  const [promptText, setPromptText] = useState('');
  const [promptDefault, setPromptDefault] = useState('');
  const [promptOverridden, setPromptOverridden] = useState(false);
  const [promptStatus, setPromptStatus] = useState(null);
  const promptDirty = promptText !== '' && promptText !== promptDefault;

  const refreshPrompt = useCallback(async () => {
    if (!cfg.bridgeUrl) return;
    try {
      const r = await fetch(`${cfg.bridgeUrl}/v1/prompts/player-persona`);
      if (!r.ok) return;
      const j = await r.json();
      setPromptText(j.text || '');
      setPromptDefault(j.default || '');
      setPromptOverridden(!!j.overridden);
    } catch { /* transient */ }
  }, []);
  useEffect(() => { refreshPrompt(); }, [refreshPrompt]);

  async function savePrompt() {
    setPromptStatus('saving…');
    try {
      const r = await fetch(`${cfg.bridgeUrl}/v1/prompts/player-persona`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: promptText }),
      });
      if (!r.ok) throw new Error(await r.text());
      await refreshPrompt();
      setPromptStatus('saved');
      setTimeout(() => setPromptStatus(null), 1500);
    } catch (e) { setPromptStatus(`error: ${e.message || e}`); }
  }
  async function resetPromptToDefault() {
    setPromptStatus('resetting…');
    try {
      const r = await fetch(`${cfg.bridgeUrl}/v1/prompts/player-persona`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await r.text());
      await refreshPrompt();
      setPromptStatus('reset');
      setTimeout(() => setPromptStatus(null), 1500);
    } catch (e) { setPromptStatus(`error: ${e.message || e}`); }
  }

  async function newCharacter() {
    setSpawnError(null);
    try {
      const r = await fetch(`${cfg.bridgeUrl}/characters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(await r.text());
      const c = await r.json();
      await onRefresh?.();
      onInspect(c.pubkey, 'profile');
    } catch (err) {
      setSpawnError(err.message || String(err));
    }
  }

  return (
    <aside className="sandbox3-cards">
      <nav className="sandbox3-sidebar-tabs" role="tablist" aria-label="sidebar">
        <button
          type="button"
          role="tab"
          aria-selected={sidebarTab === 'agents'}
          className={`sandbox3-sidebar-tab${sidebarTab === 'agents' ? ' active' : ''}`}
          onClick={() => setSidebarTab('agents')}
        >Agents</button>
        <button
          type="button"
          role="tab"
          aria-selected={sidebarTab === 'pets'}
          className={`sandbox3-sidebar-tab${sidebarTab === 'pets' ? ' active' : ''}`}
          onClick={() => setSidebarTab('pets')}
        >Pets</button>
      </nav>
      {sidebarTab === 'agents' ? (
        <>
          <header>
            <h2>Agents</h2>
            <div className="npcs-header-actions">
              <button onClick={newCharacter} title="Create a new character with a random name + keypair">
                + New
              </button>
              <button
                type="button"
                className={`npcs-settings-toggle${showSettings ? ' is-open' : ''}`}
                onClick={() => setShowSettings((v) => !v)}
                title={showSettings ? 'Hide settings' : 'Persona settings'}
                aria-expanded={showSettings}
              >
                <IconSettings />
              </button>
            </div>
          </header>
          {registeredWorlds.length > 0 && (
            <nav className="sandbox3-worlds-legend" aria-label="Worlds">
              {registeredWorlds.map((w) => {
                const meta = WORLD_META[w.world.toLowerCase()] ?? null;
                const href = meta?.href ?? '#';
                const worldKey = meta ? meta.routeView === 'game' ? 'sims' : meta.routeView : null;
                const isActive = worldKey != null && worldKey === activeWorld;
                return (
                  <a
                    key={w.world}
                    href={href}
                    className={`sandbox3-worlds-legend-chip${isActive ? ' is-active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    title={isActive ? `${w.world} — current world` : `Switch to ${w.world}`}
                  >
                    <span className="sandbox3-worlds-legend-icon" aria-hidden="true">{w.icon ?? '■'}</span>
                    <span className="sandbox3-worlds-legend-label">{w.world}</span>
                  </a>
                );
              })}
            </nav>
          )}
          {showSettings && (
            <div className="npcs-settings-pane">
              <section className="npcs-pane">
                <h2>Persona prompt</h2>
                <p className="muted">
                  System prompt used when generating a player character's persona.{' '}
                  {promptOverridden
                    ? <strong>Currently overridden.</strong>
                    : <span>Currently the default.</span>}
                </p>
                <textarea
                  className="npcs-prompt"
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  spellCheck={false}
                  rows={14}
                />
                <div className="npcs-form-actions">
                  <button type="button" className="npcs-btn primary" onClick={savePrompt} disabled={!promptDirty}>
                    Save
                  </button>
                  <button type="button" className="npcs-btn" onClick={resetPromptToDefault} disabled={!promptOverridden}>
                    Reset to default
                  </button>
                  {promptStatus && <span className="npcs-status">{promptStatus}</span>}
                </div>
              </section>
            </div>
          )}
          {spawnError && <p className="agent-sandbox-error">{spawnError}</p>}
          {characters.length > 0 && (() => {
            const tabs = [
              { id: 'all', label: 'All', count: characters.length },
              { id: 'added', label: 'Added', count: characters.filter((c) => c.added).length },
            ];
            return (
              <nav className="rooms-status-tabs" role="tablist" aria-label="agent filter">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button" role="tab"
                    aria-selected={agentFilter === t.id}
                    className={`rooms-status-tab${agentFilter === t.id ? ' active' : ''}`}
                    onClick={() => setAgentFilter(t.id)}
                  >
                    {t.label} <span className="rooms-status-tab-count">{t.count}</span>
                  </button>
                ))}
              </nav>
            );
          })()}
          {characters.length === 0 ? (
            <p className="muted">No agents yet. Click + New to mint one.</p>
          ) : (() => {
            const filtered = characters.filter((c) => agentFilter === 'added' ? !!c.added : true);
            if (filtered.length === 0) {
              return <p className="muted">No agents match this filter.</p>;
            }
            return (
              <ul className="sandbox3-card-list">
                {filtered.map((c) => (
                  <CharacterCard
                    key={c.pubkey}
                    character={c}
                    selected={!!inspectedId && (inspectedId === c.pubkey || inspectedId === c.runtime?.agentId)}
                    onInspect={onInspect}
                    onRefresh={onRefresh}
                  />
                ))}
              </ul>
            );
          })()}
        </>
      ) : (
        <PetsPlaceholder />
      )}
    </aside>
  );
}

function CharacterCard({ character: c, selected, onInspect, onRefresh }) {
  const runtime = c.runtime?.running ? c.runtime : null;
  const thinking = !!runtime?.thinking;
  const worlds = useRegisteredWorlds();
  // Each registered world reports whether this character is alive in
  // it; we render one "Stop in <World>" button per match. Sims uses
  // the bridge runtime flag; Shelter / Colony check their local stores.
  const liveIn = useMemo(
    () => worlds.filter((w) => { try { return w.isInstantiated(c); } catch { return false; } }),
    [worlds, c],
  );
  const handleStop = async (w) => {
    try { await w.stop(c); } catch (err) { /* eslint-disable-next-line no-console */ console.warn('[stop]', w.world, err); }
    await onRefresh?.();
  };
  const initial = (c.name || '?').trim().charAt(0).toUpperCase();
  const onDragStart = useCallback((e) => {
    e.dataTransfer.setData('application/x-character-pubkey', c.pubkey);
    e.dataTransfer.effectAllowed = 'copyMove';
    const portrait = e.currentTarget.querySelector('.sandbox3-card-portrait');
    if (portrait) {
      try { e.dataTransfer.setDragImage(portrait, 28, 28); } catch {}
    }
  }, [c.pubkey]);
  const handleClick = useCallback(() => {
    onInspect(runtime ? runtime.agentId : c.pubkey, runtime ? 'context' : 'profile');
  }, [c.pubkey, runtime, onInspect]);
  // Token gauge — same shape as the original Sandbox card.
  const gauge = runtime?.lastUsage ? (() => {
    const total = runtime.lastUsage.totalTokens ?? 0;
    const cap = 131072;
    const pct = Math.min(100, (total / cap) * 100);
    const level = pct > 80 ? 'red' : pct > 50 ? 'amber' : 'green';
    return { total, cap, pct, level };
  })() : null;
  const h = runtime?.harness || c.harness;
  const isExternal = h === 'external';
  const driver = runtime?.externalDriver || null;
  const m = isExternal ? driver : (runtime?.model || c.model);
  const compactModel = !m ? null : isExternal ? m : m.split('/').pop().replace(/-(?:E?\d+B|Q\d+_K_M).*$/i, '');
  return (
    <li
      className={`sandbox3-card${runtime ? ' running' : ''}${thinking ? ' thinking' : ''}${selected ? ' selected' : ''}`}
      draggable
      onDragStart={onDragStart}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      title={runtime
        ? "Click to inspect. Drag to move on the map. Use Profile to edit."
        : "Drag onto a world to spawn. Use Profile to edit."}
    >
      <div className="sandbox3-card-portrait">
        {c.avatarUrl ? (
          <img src={c.avatarUrl} alt={c.name} draggable={false} />
        ) : (
          <div className="sandbox3-card-portrait-fallback">{initial}</div>
        )}
        {runtime && <span className="sandbox3-card-dot" title={thinking ? 'thinking' : 'listening'} />}
      </div>
      <div className="sandbox3-card-body">
        <div className="sandbox3-card-name">{c.name}</div>
        {runtime && (
          <div className="sandbox3-card-status">
            {thinking ? 'thinking…' : 'listening'} · {runtime.turns} turn{runtime.turns === 1 ? '' : 's'}
          </div>
        )}
        {(m || h || c.starter || c.added) && (
          <div className="sandbox3-card-tags">
            {c.starter && (
              <span className="sandbox3-card-tag sandbox3-card-tag-starter" title="Featured in the wake-up tutorial recruit carousel">
                starter
              </span>
            )}
            {c.added && (
              <span className="sandbox3-card-tag sandbox3-card-tag-added" title="In the curated pool for the live shelter + trailer demo">
                added
              </span>
            )}
            {m && (
              <span className="sandbox3-card-tag sandbox3-card-tag-model" title={isExternal ? `external driver: ${m}` : `model: ${m}`}>
                {compactModel}
              </span>
            )}
            {h && (
              <span className="sandbox3-card-tag sandbox3-card-tag-harness" title={`brain: ${h}`}>
                {h}
              </span>
            )}
          </div>
        )}
        {gauge && (
          <div className={`sandbox3-card-gauge level-${gauge.level}`}
            title={`${gauge.total.toLocaleString()} / ${gauge.cap.toLocaleString()} tokens · ${gauge.pct.toFixed(1)}%`}>
            <div className="sandbox3-card-gauge-bar">
              <div className="sandbox3-card-gauge-fill" style={{ width: `${gauge.pct}%` }} />
            </div>
            <span>{gauge.total.toLocaleString()}<small> / {(gauge.cap / 1000).toFixed(0)}K</small></span>
          </div>
        )}
        {c.about && <p className="sandbox3-card-about">{c.about}</p>}
        {c.state && (
          <p className="sandbox3-card-state" title={c.state}>
            <span className="sandbox3-card-state-label">state</span>
            {c.state}
          </p>
        )}
        {liveIn.length > 0 && (
          <div className="sandbox3-card-actions">
            {liveIn.map((w) => (
              <button
                key={w.world}
                type="button"
                onClick={(e) => { e.stopPropagation(); handleStop(w); }}
                className="sandbox3-card-stop"
                title={`Stop ${c.name} in ${w.world}`}
                aria-label={`Stop ${c.name} in ${w.world}`}
              >
                <span className="sandbox3-card-stop-icon" aria-hidden="true">{w.icon ?? '■'}</span>
                <span className="sandbox3-card-stop-x" aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function PetsPlaceholder() {
  return (
    <>
      <header>
        <h2>Pets</h2>
        <small className="muted">coming soon</small>
      </header>
      <div className="sandbox3-pets-placeholder">
        <p className="muted">
          A spot reserved for a future companions / familiars feature.
          Cards will live here.
        </p>
      </div>
    </>
  );
}

function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

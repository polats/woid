import { useEffect, useState } from 'react';
import { useColonyStore, useColonyStoreApi } from '../hooks/useColonyStore.js';
import { findEmptyTile, makeDupe } from '../lib/colony/world.js';

/**
 * Colony dev panel — reuses Shelter's `.shelter-debug-*` CSS so the
 * button + panel sit in the same top-right corner of the phone screen.
 * One visual idiom across both games.
 */
export default function ColonyDebug() {
  const [open, setOpen] = useState(false);
  const snapshot = useColonyStore();
  const store = useColonyStoreApi();

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Backquote') return;
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!import.meta.env.DEV) return null;

  const dupeIds = Object.keys(snapshot.dupes);
  const onSpawn = () => {
    const id = `dupe-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const pos = findEmptyTile(snapshot);
    store.addDupe(makeDupe(id, `Recruit-${dupeIds.length + 1}`, pos));
  };
  const onRemoveLast = () => {
    const last = dupeIds[dupeIds.length - 1];
    if (last) store.removeDupe(last);
  };
  const onReset = () => {
    if (confirm('Reset Colony to a fresh world? Save data will be lost.')) store.reset();
  };
  const onFastForward = () => store.fastForwardTicks(60 * 4);
  const onDump = () => {
    // eslint-disable-next-line no-console
    console.log('[Colony] snapshot:', JSON.parse(JSON.stringify(snapshot)));
  };

  if (!open) {
    return (
      <button
        type="button"
        className="shelter-debug-button"
        onClick={() => setOpen(true)}
        title="Toggle Colony dev panel (`)"
      >
        DEV
      </button>
    );
  }

  return (
    <aside className="shelter-debug-panel" role="dialog" aria-label="Colony dev panel">
      <header className="shelter-debug-header">
        <span>Colony · DEV</span>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button>
      </header>
      <div className="shelter-debug-status">
        tick {snapshot.simTicks} · {dupeIds.length} dupes · ore {Math.round(snapshot.resources.ore ?? 0)} · food {Math.round(snapshot.resources.food ?? 0)}
      </div>
      <h4>Actions</h4>
      <div className="colony-debug-actions">
        <button type="button" onClick={onSpawn}>+ Spawn dupe</button>
        <button type="button" onClick={onRemoveLast} disabled={dupeIds.length === 0}>− Remove last</button>
        <button type="button" onClick={onFastForward}>⏩ Fast-forward 1 sim-min</button>
        <button type="button" onClick={onDump}>⎘ Dump JSON</button>
        <button type="button" onClick={onReset} className="danger">Reset world</button>
      </div>
      <h4>Dupes</h4>
      <ul className="shelter-debug-roster">
        {Object.values(snapshot.dupes).map((d) => (
          <li key={d.id} className="shelter-debug-roster-item">
            <div className="shelter-debug-roster-meta">
              <div className="name">{d.name}</div>
              <div className="state">
                ({d.pos.x},{d.pos.y}) · E{Math.round(d.needs.energy)} F{Math.round(d.needs.food)} · {d.currentAction}
              </div>
            </div>
            <button type="button" onClick={() => store.removeDupe(d.id)} title="Remove">×</button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

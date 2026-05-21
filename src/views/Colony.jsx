import { useCallback, useEffect, useMemo, useRef } from 'react';
import RoomMap from '../RoomMap.jsx';
import { useColonyStore, useColonyStoreApi } from '../hooks/useColonyStore.js';
import { useColonyTick } from '../hooks/useColonyTick.js';
import { useWorldDrop } from '../hooks/useWorldDrop.js';
import { createColonyLoop } from '../lib/colony/loop.js';
import { findDupeByAgentPubkey, makeDupe } from '../lib/colony/world.js';
import ColonyDebug from './ColonyDebug.jsx';
import AgentSandboxFab from '../components/AgentSandboxFab.jsx';

/**
 * Colony — ONI-flavored colony sim demo.
 *
 * The view is intentionally thin: read the store, project dupes +
 * tiles into the RoomMap renderer (already used by Sims), expose
 * resources at the top, and float a debug panel for dev controls.
 *
 * Phase 2a ships this without autonomous behaviour — dupes stand
 * still until Phase 2b wires the brain. The tick loop still runs so
 * needs decay over time.
 */

const COLONY_GLYPHS = {
  ore_deposit: '⛰️',
  bed:         '🛏️',
  kitchen:     '🍳',
  wall:        '▣',
};

function glyphFor(type) {
  return COLONY_GLYPHS[type] ?? '◆';
}

export default function Colony() {
  const snapshot = useColonyStore();

  // Singleton behaviour loop. Created once per Colony mount; reused
  // across tick frames. The loop owns brains-per-dupe + the perception
  // bus + the moodlets tracker.
  const loopRef = useRef(null);
  if (!loopRef.current) loopRef.current = createColonyLoop();
  const runBehaviour = useCallback(
    (store, ticks) => loopRef.current?.tick(store, ticks),
    [],
  );
  useColonyTick(runBehaviour);

  useEffect(() => {
    return () => {
      // Reset the loop on unmount so a fresh mount (after navigation)
      // doesn't carry stale brains.
      loopRef.current = null;
    };
  }, []);

  const storeApi = useColonyStoreApi();
  const onDropCharacter = useWorldDrop({
    world: 'Colony',
    isInstantiated: (c) => !!findDupeByAgentPubkey(storeApi.getSnapshot(), c.pubkey),
    spawn: (character, target) => {
      const dupeId = `agent-${character.pubkey.slice(0, 8)}`;
      storeApi.addDupe(makeDupe(
        dupeId,
        character.name,
        { x: target.x, y: target.y },
        Math.random,
        { agentPubkey: character.pubkey },
      ));
    },
  });

  const { width, height, tiles } = snapshot.grid;

  // Project tiles into RoomMap's object format: { x, y, type }.
  const objects = useMemo(() => {
    const out = [];
    for (const [key, tile] of Object.entries(tiles ?? {})) {
      const [x, y] = key.split(',').map(Number);
      out.push({ x, y, type: tile.type, ...tile });
    }
    return out;
  }, [tiles]);

  // The whole grid is a single "floor" region so RoomMap's
  // wall-detection doesn't classify every empty tile as out-of-bounds.
  const rooms = useMemo(() => ([
    { id: 'colony-floor', type: 'floor', x: 0, y: 0, w: width, h: height, color: '#1a1d22' },
  ]), [width, height]);

  // Dupes → RoomMap's roomAgents shape (uses npub field as the id; we
  // pass the dupe id there) and a characters shape for name display.
  const roomAgents = useMemo(() => Object.values(snapshot.dupes).map((d) => ({
    npub: d.id,
    name: d.name,
    x: d.pos.x,
    y: d.pos.y,
  })), [snapshot.dupes]);

  const characters = useMemo(() => Object.values(snapshot.dupes).map((d) => ({
    pubkey: d.id,
    name: d.name,
    needs: d.needs,
  })), [snapshot.dupes]);

  return (
    <div className="game-view">
      <div className="game-phone-frame">
        <div className="game-phone-notch" />
        <div className="game-phone-screen colony-view">
          <AgentSandboxFab />
          <ColonyDebug />
          <div className="game-status-bar">
            <span>9:41</span>
            <span>●●● ▮▮</span>
          </div>
          <div className="game-screen-body">
            <header className="colony-header">
              <div className="colony-title">
                <strong>Colony</strong>
                <span className="colony-subtitle">tick {snapshot.simTicks}</span>
              </div>
              <ColonyResourceBar resources={snapshot.resources} />
            </header>
            <div className="colony-map-wrap">
              <RoomMap
                width={width}
                height={height}
                rooms={rooms}
                objects={objects}
                characters={characters}
                roomAgents={roomAgents}
                showGrid={true}
                showLabels={false}
                showCaption={false}
                glyphFor={glyphFor}
                onDropCharacter={onDropCharacter}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ColonyResourceBar({ resources = {} }) {
  const entries = [
    ['Ore',      resources.ore     ?? 0, '⛏️'],
    ['Food',     resources.food    ?? 0, '🍞'],
    ['Oxygen',   resources.oxygen  ?? 0, '💨'],
    ['Material', resources.material ?? 0, '🧱'],
  ];
  return (
    <ul className="colony-resource-bar">
      {entries.map(([label, value, glyph]) => (
        <li key={label} title={label}>
          <span className="g">{glyph}</span>
          <span className="v">{Math.round(value)}</span>
          <span className="l">{label}</span>
        </li>
      ))}
    </ul>
  );
}

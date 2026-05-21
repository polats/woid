import { useCallback, useEffect, useState } from 'react';
import config from '../config.js';

/**
 * useBridgeCharacters — single source of truth for the player roster.
 *
 * Polls `${bridgeUrl}/characters?kind=player` every 3 s (same cadence
 * Sandbox.jsx has used since #135). Returns the current list + a
 * `refresh()` function that forces a re-fetch after mutating writes.
 *
 * Every world view that supports drag-to-spawn calls this so its
 * `onDropCharacter` handler can look the character up locally — no
 * second HTTP fetch per drop, no diverging copies of the list.
 */

const cfg = config.agentSandbox || {};
const POLL_MS = 3000;

export function useBridgeCharacters() {
  const [characters, setCharacters] = useState([]);
  const refresh = useCallback(async () => {
    if (!cfg.bridgeUrl) return;
    try {
      const r = await fetch(`${cfg.bridgeUrl}/characters?kind=player`);
      if (!r.ok) return;
      const json = await r.json();
      setCharacters(json.characters ?? []);
    } catch { /* transient — next poll retries */ }
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);
  return { characters, refresh };
}

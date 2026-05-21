import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js';
import { useColonyStore, useColonyStoreApi } from '../hooks/useColonyStore.js';
import { useBridgeCharacters } from '../hooks/useBridgeCharacters.js';
import { useWorldRegistration } from '../hooks/useWorldRegistration.js';
import { stopBridgeAgent } from '../lib/bridgeSpawn.js';
import { findDupeByAgentPubkey } from '../lib/colony/world.js';
import { WORLD_META } from '../lib/worldIcons.js';
import config from '../config.js';

const cfg = config.agentSandbox || {};

/**
 * Single mount point that registers every world with the world
 * registry. Lives at the App root so registrations survive route
 * changes — a character instantiated in Shelter still surfaces a
 * "Stop in Shelter" button while the user is over in Sims or Colony.
 *
 * Per-world spawn (drop) handlers stay in their views because they
 * need view-only context (raycaster hits, room geometry). Lifecycle
 * (isInstantiated + stop) is store-only, so it lives here.
 */
export default function WorldRegistrations() {
  const { characters, refresh: refreshCharacters } = useBridgeCharacters();
  useWorldRegistration({
    world: 'Sims',
    icon: WORLD_META.sims.icon,
    version: characters,
    isInstantiated: (c) => !!c.runtime?.running,
    stop: async (c) => {
      await stopBridgeAgent({ bridgeUrl: cfg.bridgeUrl, character: c });
      await refreshCharacters();
    },
  });

  const shelterSnap = useShelterStore();
  const shelterApi = useShelterStoreApi();
  const findShelterAgentId = (c) => {
    if (shelterSnap.agents?.[c.pubkey]) return c.pubkey;
    const hit = Object.values(shelterSnap.agents ?? {}).find((a) => a.pubkey === c.pubkey);
    return hit?.id ?? null;
  };
  useWorldRegistration({
    world: 'Shelter',
    icon: WORLD_META.shelter.icon,
    version: shelterSnap.agents,
    isInstantiated: (c) => !!findShelterAgentId(c),
    stop: (c) => {
      const id = findShelterAgentId(c);
      if (id) shelterApi.removeAgent(id);
    },
  });

  const colonySnap = useColonyStore();
  const colonyApi = useColonyStoreApi();
  useWorldRegistration({
    world: 'Colony',
    icon: WORLD_META.colony.icon,
    version: colonySnap.dupes,
    isInstantiated: (c) => !!findDupeByAgentPubkey(colonyApi.getSnapshot(), c.pubkey),
    stop: (c) => {
      const d = findDupeByAgentPubkey(colonyApi.getSnapshot(), c.pubkey);
      if (d) colonyApi.removeDupe(d.id);
    },
  });

  return null;
}

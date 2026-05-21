import { useCallback } from 'react';
import { useBridgeCharacters } from './useBridgeCharacters.js';

/**
 * useCharacterDrop — the shared drop chain across every world.
 *
 *   const onDropCharacter = useCharacterDrop((character, target) => {
 *     // instantiate `character` (a bridge character object) in this
 *     // world's store. Idempotency / world-specific positioning lives
 *     // here.
 *   })
 *
 * The hook owns the lookup: it pulls the current bridge roster from
 * `useBridgeCharacters` and resolves the drop's pubkey into the full
 * character object before calling your `applyToWorld` callback.
 *
 * Sims has used this shape since the original Sandbox.jsx; this hook
 * just lifts the pattern so Colony, Shelter, and any future world
 * share the exact same drop path.
 */
export function useCharacterDrop(applyToWorld) {
  const { characters } = useBridgeCharacters();
  return useCallback((pubkey, targetOrX, maybeY) => {
    if (!pubkey) return;
    // RoomMap still passes (pubkey, x, y); ShelterStage3D and Colony
    // pass (pubkey, { ... }). Normalize so worlds receive a target
    // object either way.
    const target = (maybeY !== undefined)
      ? { x: targetOrX, y: maybeY }
      : targetOrX;
    const character = characters.find((c) => c.pubkey === pubkey);
    if (!character) return;
    return applyToWorld(character, target);
  }, [characters, applyToWorld]);
}

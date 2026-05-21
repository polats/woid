import { dropToastApi } from '../lib/dropToast.js';
import { useCharacterDrop } from './useCharacterDrop.js';

/**
 * useWorldDrop — drop-to-instantiate harness for any world.
 *
 *   const onDropCharacter = useWorldDrop({
 *     world: 'Colony',
 *     isInstantiated: (character) => boolean,
 *     spawn: async (character, target) => result | { toast },
 *     onSpawned: (character, target, result) => void,  // optional
 *     errorMessage: 'optional fallback' | (character, err) => string,
 *   })
 *
 * Wraps the unified roster lookup (`useCharacterDrop`) plus the
 * pending → success/error toast envelope, so each world only writes
 * the two world-specific pieces: idempotency and the mutation.
 *
 * The returned callback matches what RoomMap / ShelterStage3D expect:
 *   onDropCharacter(pubkey, target)
 *   onDropCharacter(pubkey, x, y)   // Sims legacy, normalized below
 */
export function useWorldDrop({
  world,
  isInstantiated,
  spawn,
  onSpawned,
  errorMessage,
}) {
  return useCharacterDrop(async (character, target) => {
    if (isInstantiated?.(character)) {
      dropToastApi.show(`${character.name} is already in ${world}`, 'success');
      return;
    }
    const toastId = dropToastApi.show(`Instantiating ${character.name}…`, 'pending');
    try {
      const result = await spawn(character, target);
      const toastText = result && typeof result === 'object' && result.toast
        ? result.toast
        : `${character.name} joined ${world}`;
      dropToastApi.update(toastId, toastText, 'success');
      onSpawned?.(character, target, result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[${world.toLowerCase()}-drop] error`, err);
      const msg = typeof errorMessage === 'function'
        ? errorMessage(character, err)
        : (errorMessage ?? `Couldn't place ${character.name}`);
      dropToastApi.update(toastId, msg, 'error');
    }
  });
}

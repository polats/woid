import { useEffect, useRef } from 'react';
import { worldRegistry } from '../lib/harness/registry.js';

/**
 * useWorldRegistration — every world view calls this so SandboxCards
 * (and any other surface that needs cross-world awareness) can ask:
 * "is this character live in <world>, and if so how do I stop it?"
 *
 *   useWorldRegistration({
 *     world: 'Shelter',
 *     isInstantiated: (character) => boolean,
 *     stop: (character) => void | Promise<void>,
 *   })
 *
 * The callbacks are tracked through a ref so callers can pass fresh
 * closures every render without churning the registry subscription.
 */
export function useWorldRegistration({ world, icon, isInstantiated, stop, version }) {
  const ref = useRef({ isInstantiated, stop });
  ref.current = { isInstantiated, stop };
  useEffect(() => {
    worldRegistry.register(world, {
      icon,
      isInstantiated: (c) => ref.current.isInstantiated(c),
      stop: (c) => ref.current.stop(c),
    });
    return () => worldRegistry.unregister(world);
  }, [world, icon]);
  // `version` is any value that changes when the world's instantiation
  // state changes (e.g. a store snapshot reference). Bumping the
  // registry forces subscribers to recompute `isInstantiated(c)`.
  useEffect(() => {
    worldRegistry.bump();
  }, [version]);
}

/**
 * shelterWorld — the data backend for the Shelter view.
 *
 * Three concerns, three modules:
 * - characterRegistry: who exists, what model do they have?
 * - animationLibrary:  cached fetcher for kimodo motion JSON.
 * - avatarFactory:     given an npub, hand back a 3D Group (+ animator).
 * - presenceProjector: bridge tile coords → shelter world coords.
 *
 * See docs/design/shelter-data-backend.md for the architecture writeup.
 */
export { animationLibrary } from './animationLibrary.js'
export { createCharacterRegistry } from './characterRegistry.js'
export { createAvatarFactory } from './avatarFactory.js'
export { createPresenceProjector } from './presenceProjector.js'

/**
 * Single source of truth for world display metadata. Used by:
 *   - WorldRegistrations.jsx (registers icon with worldRegistry)
 *   - layout/Sidebar.jsx (renders world links)
 *   - SandboxCards.jsx (legend chips + stop buttons)
 */
export const WORLD_META = {
  sims:    { label: 'Sims',    icon: '◆', href: '#/game',    routeView: 'game' },
  shelter: { label: 'Shelter', icon: '⌂', href: '#/shelter', routeView: 'shelter' },
  colony:  { label: 'Colony',  icon: '▣', href: '#/colony',  routeView: 'colony' },
};

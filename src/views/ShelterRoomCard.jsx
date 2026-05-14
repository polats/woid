import { useShelterStore } from '../hooks/useShelterStore.js'
import { getRoomType } from '../lib/shelterWorld/roomTypes.js'
import { roomXpPerLevel, roomLevelMultiplier, tierMultiplier } from '../lib/shelterStore/index.js'

/**
 * Compact room info card mounted at the top of the shelter stage when
 * a room is selected (single-tap) or focused (double-tap). Shows the
 * room name, tier, room level, and a progress bar toward the next
 * room level. Mirrors the ShelterCharacterCard aesthetic (same paper
 * + ink shell) but lays out horizontally and keeps a small footprint.
 *
 * Props:
 *   roomId — null hides the card; non-null reads its store entry +
 *            catalogue entry and renders the row.
 */
export default function ShelterRoomCard({ roomId, name: nameFromCaller = null }) {
  const snap = useShelterStore()
  if (!roomId) return null
  const room = snap?.rooms?.[roomId] ?? null
  // Name source matches the prior bottom-label: the stage emits the
  // displayed name (from group.userData.room.name) through
  // onFocusChange / onSelectionChange; fall back to the catalogue
  // and finally the id if neither is available.
  const type = getRoomType(roomId) ?? getRoomType(room?.type ?? roomId)
  const name = nameFromCaller ?? type?.name ?? roomId
  const category = type?.category ?? 'room'
  const tier = Number(type?.tier ?? 1)
  const level = Math.max(1, Number(room?.level ?? 1))
  const xp = Math.max(0, Number(room?.xp ?? 0))
  const per = roomXpPerLevel(tier)
  const xpInLevel = xp % per
  const pct = Math.min(100, (xpInLevel / per) * 100)
  const mult = roomLevelMultiplier(level) * tierMultiplier(tier)

  return (
    <aside className="shelter-room-card" role="status" aria-live="polite">
      <header className="shelter-room-card-head">
        <strong className="shelter-room-card-name">{name}</strong>
      </header>
      <div className="shelter-room-card-body">
        <div className="shelter-room-card-meta">
          <span className="shelter-room-card-tier">Tier {tier}</span>
          <span className="shelter-room-card-lvl">Lv {level}</span>
          <span className="shelter-room-card-cat">{category}</span>
          <span className="shelter-room-card-mult">×{mult.toFixed(2)} xp</span>
        </div>
        <div className="shelter-room-card-bar" title={`${xpInLevel}/${per} collections to next room level`}>
          <div className="shelter-room-card-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </aside>
  )
}

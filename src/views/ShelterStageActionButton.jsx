import { motion } from 'framer-motion'
import { useShelterStore, useShelterStoreApi } from '../hooks/useShelterStore.js'
import { getRoomType } from '../lib/shelterWorld/roomTypes.js'
import { start as startAssignmentMode } from '../lib/shelterAssignmentMode.js'

const BUTTON_ANIM = {
  initial: { y: 24, opacity: 0 },
  animate: { y: 0, opacity: 1 },
  exit: { y: 24, opacity: 0 },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
}

/**
 * Stage-level Reassign / Collect button for the currently focused
 * agent. Rendered beside the 3D character portrait at the bottom of
 * the phone screen, not inside the character card.
 *
 * Three states:
 *   - no agent / no assignment      → "Pick room"
 *   - assigned, production timer    → "Reassign · <room> · ¤<reward>"
 *                                     (fills with production %)
 *   - assigned, ready to collect    → "Collect · ¤<reward>" (red, pulsing)
 */
export default function ShelterStageActionButton({ agent }) {
  const snap = useShelterStore()
  const api = useShelterStoreApi()

  if (!agent?.id) return null

  const liveAgent = snap?.agents?.[agent.id] ?? null
  const manualRoomId = liveAgent?.manualAssignment?.roomId ?? null
  const assignedRoom = manualRoomId ? snap?.rooms?.[manualRoomId] : null
  const assignedRoomType = manualRoomId ? getRoomType(manualRoomId) : null
  const ready = !!assignedRoom?.productionReady
  const reward = Number(assignedRoomType?.rewardCash ?? 0)
  const dur = Number(assignedRoomType?.productionDuration ?? 0)
  const timer = Number(assignedRoom?.productionTimer ?? 0)
  const productionPct = dur > 0 ? Math.min(100, (timer / dur) * 100) : 0

  const onAssign = () => {
    if (!agent?.id) return
    startAssignmentMode(agent.id, ({ agentId, roomId }) => {
      api.setAssignment(agentId, roomId)
    })
  }
  const onCollect = () => {
    if (!manualRoomId) return
    api.collectRoom(manualRoomId, {
      rewardCash: reward,
      rewardXp: Number(assignedRoomType?.rewardXp ?? 0),
      tier: Number(assignedRoomType?.tier ?? 1),
    })
  }

  if (!manualRoomId) {
    return (
      <motion.button
        {...BUTTON_ANIM}
        type="button"
        className="shelter-stage-action shelter-stage-action-pick"
        onClick={onAssign}
      >
        <span className="shelter-stage-action-primary">Pick room</span>
      </motion.button>
    )
  }
  if (ready) {
    return (
      <motion.button
        {...BUTTON_ANIM}
        type="button"
        className="shelter-stage-action shelter-stage-action-collect"
        onClick={onCollect}
        title={`Collect ¤${reward}`}
      >
        <span className="shelter-stage-action-fill" style={{ width: '100%' }} />
        <span className="shelter-stage-action-label">
          <span className="shelter-stage-action-primary">Collect</span>
          <span className="shelter-stage-action-sub">¤{reward}</span>
        </span>
      </motion.button>
    )
  }
  return (
    <motion.button
      {...BUTTON_ANIM}
      type="button"
      className="shelter-stage-action shelter-stage-action-reassign"
      onClick={onAssign}
      title={`Reassign — ${assignedRoomType?.name ?? manualRoomId} · ¤${reward} · ${Math.round(productionPct)}%`}
    >
      <span className="shelter-stage-action-fill" style={{ width: `${productionPct}%` }} />
      <span className="shelter-stage-action-label">
        <span className="shelter-stage-action-primary">Reassign</span>
        <span className="shelter-stage-action-sub">
          {(assignedRoomType?.name ?? manualRoomId)} · ¤{reward}
        </span>
      </span>
    </motion.button>
  )
}

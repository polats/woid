import { useState } from 'react'
import ShelterStage3D from './ShelterStage3D.jsx'

export default function Shelter() {
  const [focused, setFocused] = useState(null)
  return (
    <div className="game-view shelter-view">
      <div className="game-phone-frame">
        <div className="game-phone-notch" />
        <div className="game-phone-screen">
          <div className="game-status-bar">
            <span>9:41</span>
            <span>●●● ▮▮</span>
          </div>
          <div className="shelter-screen-body">
            <ShelterStage3D onFocusChange={setFocused} />
            <div className={`shelter-room-label${focused ? ' visible' : ''}`}>
              {focused?.name ?? ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

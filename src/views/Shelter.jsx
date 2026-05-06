import { useState } from 'react'
import ShelterStage3D from './ShelterStage3D.jsx'
import ShelterDebug from './ShelterDebug.jsx'
import ShelterAgentList from './ShelterAgentList.jsx'

const TABS = [
  { id: 'stage',  label: 'Stage',  glyph: '◆' },
  { id: 'agents', label: 'Agents', glyph: '◌' },
]

export default function Shelter() {
  const [tab, setTab] = useState('stage')
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
          <div className="game-screen-body">
            {/* Stage stays mounted across tab switches so the WebGL
                context survives — same trick Sims uses. */}
            <div className="game-tab-pane" hidden={tab !== 'stage'}>
              <div className="shelter-screen-body">
                <ShelterStage3D onFocusChange={setFocused} />
                <div className={`shelter-room-label${focused ? ' visible' : ''}`}>
                  {focused?.name ?? ''}
                </div>
                {import.meta.env.DEV && <ShelterDebug />}
              </div>
            </div>
            <div className="game-tab-pane" hidden={tab !== 'agents'}>
              <ShelterAgentList />
            </div>
          </div>
          <nav className="game-tab-bar" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`game-tab${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="game-tab-glyph">{t.glyph}</span>
                <span className="game-tab-label">{t.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>
    </div>
  )
}

import { useState, useSyncExternalStore } from 'react'
import ShelterStage3D from './ShelterStage3D.jsx'
import ShelterDebug from './ShelterDebug.jsx'
import ShelterAgentList from './ShelterAgentList.jsx'
import ShelterCharacterCard from './ShelterCharacterCard.jsx'
import TutorialOverlay from './TutorialOverlay.jsx'
import { subscribe as subTutorial, getState as getTutorial } from '../lib/tutorial/runtime.js'

const TABS = [
  { id: 'stage',  label: 'Stage',  glyph: '◆' },
  { id: 'agents', label: 'Agents', glyph: '◌' },
]

export default function Shelter() {
  const [tab, setTab] = useState('stage')
  const [focused, setFocused] = useState(null)
  const [focusedAgent, setFocusedAgent] = useState(null)
  const tutorial = useSyncExternalStore(subTutorial, getTutorial)
  // The character card overlays the lower portion of the stage. While
  // a tutorial is running it would block the cinematic framing, so we
  // suppress it for the duration of the run.
  const cardAgent = tutorial.active ? null : focusedAgent
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
                <ShelterStage3D
                  onFocusChange={setFocused}
                  onAgentFocusChange={setFocusedAgent}
                />
                <div className={`shelter-room-label${focused ? ' visible' : ''}`}>
                  {focused?.name ?? ''}
                </div>
                <ShelterCharacterCard agent={cardAgent} />
                {/* Dev panel — hidden behind a backtick toggle (or the
                    floating "DEV" button) so it stays out of the way for
                    casual viewers but is reachable on prod for adding
                    NPCs / inspecting state. */}
                <ShelterDebug />
                {/* Tutorial scrim + dialog box. Sits above the stage
                    but below the dev panel so the panel can still be
                    toggled while a step is paused for input. */}
                <TutorialOverlay />
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

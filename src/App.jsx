import { useCallback, useEffect, useState } from 'react'
import config from './config.js'
import { useHashRoute } from './hooks/useHashRoute.js'
import Sidebar from './layout/Sidebar.jsx'
import Board from './Board.jsx'
import Diagram from './Diagram.jsx'
import Reference from './Reference.jsx'
import Sandbox from './Sandbox.jsx'
import RelayFeed from './RelayFeed.jsx'
import Testing from './Testing.jsx'
import Doc from './views/Doc.jsx'
import Personas from './views/Personas.jsx'
import ImagePosts from './views/ImagePosts.jsx'
import Network from './views/Network.jsx'
import Journal from './views/Journal.jsx'
import Game from './views/Game.jsx'

// Top-level docs (Docs section).
const modules = import.meta.glob('../docs/*.md', { query: '?raw', import: 'default', eager: true })
const docs = Object.entries(modules)
  .map(([p, content]) => ({ name: p.split('/').pop().replace(/\.md$/, ''), content }))
  .sort((a, b) => a.name.localeCompare(b.name))

// Research docs live in docs/research/. Surfaced under their own
// collapsed section in the sidebar (alongside Dev) so the main Docs
// list stays focused on user-facing setup + how-tos. Routing is the
// same — every research file is reachable at #/docs/<filename>.
const researchModules = import.meta.glob('../docs/research/*.md', { query: '?raw', import: 'default', eager: true })
const research = Object.entries(researchModules)
  .map(([p, content]) => ({ name: p.split('/').pop().replace(/\.md$/, ''), content }))
  .sort((a, b) => {
    // Keep `index` first, everything else alphabetical.
    if (a.name === 'index') return -1
    if (b.name === 'index') return 1
    return a.name.localeCompare(b.name)
  })

// Combined lookup table the route resolver uses regardless of section.
const allDocs = [...docs, ...research]

const homeDoc = docs.find((d) => d.name === config.home) ?? docs[0] ?? null

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (h === 'tasks') return { view: 'tasks' }
  if (h === 'agent-sandbox') return { view: 'agent-sandbox' }
  if (h === 'relay-feed') return { view: 'relay-feed' }
  if (h === 'personas') return { view: 'personas' }
  if (h === 'image-posts') return { view: 'image-posts' }
  if (h === 'network') return { view: 'network' }
  if (h === 'journal') return { view: 'journal' }
  if (h === 'game') return { view: 'game' }
  if (h === 'testing') return { view: 'testing' }
  if (h.startsWith('testing/')) return { view: 'testing', sessionName: decodeURIComponent(h.slice(8)) }
  if (h.startsWith('diagrams/')) return { view: 'diagram', id: decodeURIComponent(h.slice(9)) }
  if (h.startsWith('references/')) return { view: 'reference', id: decodeURIComponent(h.slice(11)) }
  if (h.startsWith('docs/')) return { view: 'doc', name: decodeURIComponent(h.slice(5)) }
  return { view: 'doc', name: homeDoc?.name ?? null }
}

const SIDEBAR_KEY = 'woid.sidebar.collapsed'

export default function App() {
  const route = useHashRoute(parseHash)
  const [diagrams, setDiagrams] = useState([])
  const [references, setReferences] = useState([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    // Persist across sessions; default to collapsed on narrow viewports
    // (≤768px) so the sandbox isn't immediately squeezed by the side nav.
    try {
      const saved = localStorage.getItem(SIDEBAR_KEY)
      if (saved === '1') return true
      if (saved === '0') return false
    } catch { /* ignore */ }
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches) {
      return true
    }
    return false
  })

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? '1' : '0') } catch {}
  }, [sidebarCollapsed])

  // On mobile the sidebar overlays content, so navigating into the
  // Game view should auto-dismiss it — otherwise the phone screen
  // stays hidden behind the nav.
  useEffect(() => {
    if (route.view !== 'game') return
    if (typeof window === 'undefined') return
    if (!window.matchMedia?.('(max-width: 768px)').matches) return
    setSidebarCollapsed(true)
  }, [route.view])

  // Both endpoints are served by a Vite dev plugin and are absent in
  // prod builds. Swallow failures so the Dev-section nav simply shows
  // empty lists instead of emitting unhandled rejections.
  const refreshDiagrams = useCallback(
    () => fetch('/api/diagrams').then((r) => r.ok ? r.json() : []).then(setDiagrams).catch(() => setDiagrams([])),
    [],
  )
  const refreshReferences = useCallback(
    () => fetch('/api/references/').then((r) => r.ok ? r.json() : []).then(setReferences).catch(() => setReferences([])),
    [],
  )

  useEffect(() => {
    refreshDiagrams()
    refreshReferences()
  }, [refreshDiagrams, refreshReferences])

  async function newDiagram() {
    const title = prompt('Diagram title?')
    if (!title) return
    const { id } = await fetch('/api/diagrams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then((r) => r.json())
    await refreshDiagrams()
    window.location.hash = `#/diagrams/${encodeURIComponent(id)}`
  }

  async function addReference() {
    const input = prompt('GitHub URL or owner/repo')
    if (!input) return
    const res = await fetch('/api/references/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    })
    if (!res.ok) {
      alert(`Failed: ${await res.text()}`)
      return
    }
    const { id } = await res.json()
    await refreshReferences()
    window.location.hash = `#/references/${encodeURIComponent(id)}`
  }

  const currentDoc = route.view === 'doc' ? allDocs.find((d) => d.name === route.name) : null

  return (
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar
        config={config}
        route={route}
        docs={docs}
        research={research}
        diagrams={diagrams}
        references={references}
        onNewDiagram={newDiagram}
        onAddReference={addReference}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />
      <button
        type="button"
        className="sidebar-reopen"
        onClick={() => {
          // On mobile, the Game view fills the screen — the only sensible
          // affordance for the top-left button is "leave the game" rather
          // than "open the sidebar over the phone".
          const isMobile = typeof window !== 'undefined'
            && window.matchMedia?.('(max-width: 768px)').matches
          if (route.view === 'game' && isMobile) {
            window.location.hash = `#/docs/${encodeURIComponent(homeDoc?.name ?? '')}`
            return
          }
          setSidebarCollapsed(false)
        }}
        title={route.view === 'game' ? 'Back to home' : 'Show sidebar'}
        aria-label={route.view === 'game' ? 'Back to home' : 'Show sidebar'}
        hidden={!sidebarCollapsed}
      >
        ›
      </button>
      <main className="content-area">
        {route.view === 'tasks' && <Board />}
        {route.view === 'agent-sandbox' && config.features?.agentSandbox && <Sandbox />}
        {route.view === 'relay-feed' && config.features?.agentSandbox && <RelayFeed />}
        {route.view === 'personas' && config.features?.agentSandbox && <Personas />}
        {route.view === 'image-posts' && config.features?.agentSandbox && <ImagePosts />}
        {route.view === 'network' && config.features?.agentSandbox && <Network />}
        {route.view === 'journal' && config.features?.agentSandbox && <Journal />}
        {/* Game stays mounted across route changes so the Stage3D
            WebGL context survives navigation. Mobile browsers cap
            WebGL contexts (iOS Safari ~8) and even with perfect
            disposal, rapid create/destroy crashes the page. Hide
            via CSS instead of unmounting. */}
        <div className="game-mount" hidden={route.view !== 'game'}>
          <Game />
        </div>
        {route.view === 'testing' && <Testing initialSession={route.sessionName} />}
        {route.view === 'diagram' && <Diagram key={route.id} id={route.id} />}
        {route.view === 'reference' && <Reference key={route.id} id={route.id} />}
        {route.view === 'doc' && (
          <Doc
            content={currentDoc?.content}
            cta={currentDoc?.name === homeDoc?.name ? (
              <a className="welcome-cta" href="#/game">▶ Open the Game</a>
            ) : null}
          />
        )}
      </main>
    </div>
  )
}

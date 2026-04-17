import { useCallback, useEffect, useState } from 'react'
import config from '../woid.config.json'
import { useHashRoute } from './hooks/useHashRoute.js'
import Sidebar from './layout/Sidebar.jsx'
import Board from './Board.jsx'
import Diagram from './Diagram.jsx'
import Reference from './Reference.jsx'
import Chat from './Chat.jsx'
import Doc from './views/Doc.jsx'
import LoginModal from './layout/LoginModal.jsx'

const modules = import.meta.glob('../docs/*.md', { query: '?raw', import: 'default', eager: true })

const docs = Object.entries(modules)
  .map(([p, content]) => ({ name: p.split('/').pop().replace(/\.md$/, ''), content }))
  .sort((a, b) => a.name.localeCompare(b.name))

const homeDoc = docs.find((d) => d.name === config.home) ?? docs[0] ?? null

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (h === 'tasks') return { view: 'tasks' }
  if (h.startsWith('diagrams/')) return { view: 'diagram', id: decodeURIComponent(h.slice(9)) }
  if (h.startsWith('references/')) return { view: 'reference', id: decodeURIComponent(h.slice(11)) }
  if (h.startsWith('docs/')) return { view: 'doc', name: decodeURIComponent(h.slice(5)) }
  return { view: 'doc', name: homeDoc?.name ?? null }
}

export default function App() {
  const route = useHashRoute(parseHash)
  const [diagrams, setDiagrams] = useState([])
  const [references, setReferences] = useState([])
  const [user, setUser] = useState(null)
  const [showLogin, setShowLogin] = useState(false)

  const refreshDiagrams = useCallback(
    () => fetch('/api/diagrams').then((r) => r.json()).then(setDiagrams),
    [],
  )
  const refreshReferences = useCallback(
    () => fetch('/api/references/').then((r) => r.json()).then(setReferences),
    [],
  )
  const refreshUser = useCallback(
    () => fetch('/api/github/me').then((r) => r.json()).then(setUser),
    [],
  )

  useEffect(() => {
    refreshDiagrams()
    refreshReferences()
    refreshUser()
  }, [refreshDiagrams, refreshReferences, refreshUser])

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

  async function logout() {
    await fetch('/api/github/token', { method: 'DELETE' })
    setUser(null)
  }

  const currentDoc = route.view === 'doc' ? docs.find((d) => d.name === route.name) : null

  return (
    <div className="app">
      <Sidebar
        config={config}
        route={route}
        user={user}
        onLogin={() => setShowLogin(true)}
        onLogout={logout}
        docs={docs}
        diagrams={diagrams}
        references={references}
        onNewDiagram={newDiagram}
        onAddReference={addReference}
      />
      <main className="content-area">
        {route.view === 'tasks' && <Board />}
        {route.view === 'diagram' && <Diagram key={route.id} id={route.id} />}
        {route.view === 'reference' && <Reference key={route.id} id={route.id} />}
        {route.view === 'doc' && <Doc content={currentDoc?.content} />}
      </main>
      <Chat />
      {showLogin && (
        <LoginModal
          onClose={() => setShowLogin(false)}
          onSuccess={(u) => {
            setUser(u)
            setShowLogin(false)
          }}
        />
      )}
    </div>
  )
}

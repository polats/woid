export default function Sidebar({
  config,
  route,
  docs,
  diagrams,
  references,
  onNewDiagram,
  onAddReference,
}) {
  const linkClass = (active) => `sidebar-link${active ? ' active' : ''}`

  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        <strong>{config.name}</strong>
        {config.description && <p>{config.description}</p>}
      </div>

      {config.features?.agentSandbox && (
        <>
          <h2>Sandbox</h2>
          <ul>
            <li>
              <a
                href="#/agent-sandbox"
                className={linkClass(route.view === 'agent-sandbox')}
              >
                Agent Sandbox
              </a>
            </li>
          </ul>

          <h2>Nostr Relay</h2>
          <ul>
            <li>
              <a
                href="#/relay-feed"
                className={linkClass(route.view === 'relay-feed')}
              >
                Feed
              </a>
            </li>
          </ul>
        </>
      )}

      <h2>Sprint</h2>
      <ul>
        <li>
          <a href="#/tasks" className={linkClass(route.view === 'tasks')}>Tasks</a>
        </li>
      </ul>

      <h2>Testing</h2>
      <ul>
        <li>
          <a href="#/testing" className={linkClass(route.view === 'testing')}>Sessions</a>
        </li>
      </ul>

      <h2>Diagrams</h2>
      <ul>
        {diagrams.map((d) => (
          <li key={d.id}>
            <a
              href={`#/diagrams/${encodeURIComponent(d.id)}`}
              className={linkClass(route.view === 'diagram' && route.id === d.id)}
            >
              {d.title}
            </a>
          </li>
        ))}
        <li>
          <button className="sidebar-link sidebar-action" onClick={onNewDiagram}>
            + New diagram
          </button>
        </li>
      </ul>

      <h2>References</h2>
      <ul>
        {references.map((r) => (
          <li key={r.id}>
            <a
              href={`#/references/${encodeURIComponent(r.id)}`}
              className={linkClass(route.view === 'reference' && route.id === r.id)}
            >
              {r.id}
            </a>
          </li>
        ))}
        <li>
          <button className="sidebar-link sidebar-action" onClick={onAddReference}>
            + Add reference
          </button>
        </li>
      </ul>

      <h2>Docs</h2>
      <ul>
        {docs.map((d) => (
          <li key={d.name}>
            <a
              href={`#/docs/${encodeURIComponent(d.name)}`}
              className={linkClass(route.view === 'doc' && route.name === d.name)}
            >
              {d.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  )
}

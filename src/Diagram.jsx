import { useCallback, useEffect, useRef, useState } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
} from 'reactflow'
import 'reactflow/dist/style.css'

async function api(method, body, query = '') {
  const res = await fetch(`/api/diagrams${query}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json().catch(() => ({}))
}

export default function Diagram({ id }) {
  return (
    <ReactFlowProvider>
      <DiagramInner id={id} />
    </ReactFlowProvider>
  )
}

function DiagramInner({ id }) {
  const [title, setTitle] = useState('')
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [saveState, setSaveState] = useState('saved')
  const loadedRef = useRef(false)

  useEffect(() => {
    loadedRef.current = false
    api('GET', null, `?id=${encodeURIComponent(id)}`).then((d) => {
      setTitle(d.title ?? id)
      setNodes(d.nodes ?? [])
      setEdges(d.edges ?? [])
      loadedRef.current = true
    })
  }, [id, setNodes, setEdges])

  useEffect(() => {
    if (!loadedRef.current) return
    setSaveState('dirty')
    const t = setTimeout(async () => {
      setSaveState('saving')
      try {
        await api('PUT', { id, title, nodes, edges })
        setSaveState('saved')
      } catch {
        setSaveState('error')
      }
    }, 600)
    return () => clearTimeout(t)
  }, [id, title, nodes, edges])

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, animated: false }, eds)),
    [setEdges],
  )

  const onNodeDoubleClick = useCallback(
    (_evt, node) => {
      const next = prompt('Edit node label', node.data?.label ?? '')
      if (next === null) return
      setNodes((ns) =>
        ns.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, label: next } } : n)),
      )
    },
    [setNodes],
  )

  const addNode = () => {
    const label = prompt('Node label?', 'New node')
    if (!label) return
    setNodes((ns) => [
      ...ns,
      {
        id: `n${Date.now()}`,
        data: { label },
        position: { x: 80 + Math.random() * 240, y: 80 + Math.random() * 200 },
      },
    ])
  }

  return (
    <div className="diagram">
      <div className="diagram-toolbar">
        <input
          className="diagram-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button onClick={addNode}>+ Node</button>
        <span className={`save-state ${saveState}`}>
          {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : 'Unsaved'}
        </span>
      </div>
      <div className="diagram-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDoubleClick={onNodeDoubleClick}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  )
}

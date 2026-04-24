import { useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const COLUMNS = [
  { id: 'todo', title: 'To Do' },
  { id: 'doing', title: 'In Progress' },
  { id: 'done', title: 'Done' },
]

async function api(method, body) {
  const res = await fetch('/api/tasks', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json().catch(() => ({}))
}

export default function Board() {
  const [tasks, setTasks] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [editing, setEditing] = useState(null)
  // The tasks API is served by a Vite dev plugin (server/tasks.js) and
  // therefore absent in prod builds on Vercel. Detect and show an
  // empty-state message instead of crashing the route on a 404.
  const [apiAvailable, setApiAvailable] = useState(true)

  useEffect(() => {
    api('GET')
      .then((rows) => {
        setTasks(Array.isArray(rows) ? rows : [])
        setApiAvailable(true)
      })
      .catch(() => setApiAvailable(false))
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const byColumn = useMemo(() => {
    const groups = Object.fromEntries(COLUMNS.map((c) => [c.id, []]))
    for (const t of tasks) (groups[t.status] ?? (groups[t.status] = [])).push(t)
    for (const k of Object.keys(groups)) groups[k].sort((a, b) => a.order - b.order)
    return groups
  }, [tasks])

  const activeTask = activeId ? tasks.find((t) => t.id === activeId) : null

  function findContainer(id) {
    if (COLUMNS.some((c) => c.id === id)) return id
    return tasks.find((t) => t.id === id)?.status
  }

  function handleDragOver({ active, over }) {
    if (!over) return
    const fromCol = findContainer(active.id)
    const toCol = findContainer(over.id)
    if (!fromCol || !toCol || fromCol === toCol) return
    setTasks((prev) => prev.map((t) => (t.id === active.id ? { ...t, status: toCol } : t)))
  }

  async function handleDragEnd({ active, over }) {
    setActiveId(null)
    if (!over) return
    const toCol = findContainer(over.id)
    if (!toCol) return

    setTasks((prev) => {
      const moved = prev.find((t) => t.id === active.id)
      if (!moved) return prev
      const others = prev.filter((t) => t.id !== active.id)
      const colItems = others.filter((t) => t.status === toCol).sort((a, b) => a.order - b.order)
      const overIdx = colItems.findIndex((t) => t.id === over.id)
      const insertAt = overIdx === -1 ? colItems.length : overIdx
      colItems.splice(insertAt, 0, { ...moved, status: toCol })
      const reordered = colItems.map((t, i) => ({ ...t, order: i }))
      const next = [...others.filter((t) => t.status !== toCol), ...reordered]

      for (const t of reordered) {
        api('PUT', t).catch((e) => console.error('save failed', t.id, e))
      }
      return next
    })
  }

  async function addTask(status) {
    const title = prompt('Task title?')
    if (!title) return
    const { id } = await api('POST', { title, status })
    const fresh = await api('GET')
    setTasks(fresh)
  }

  async function saveTask(updated) {
    await api('PUT', updated)
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    setEditing(null)
  }

  async function deleteTask(id) {
    await api('DELETE', { id })
    setTasks((prev) => prev.filter((t) => t.id !== id))
    setEditing(null)
  }

  if (!apiAvailable) {
    return (
      <div className="board board-embedded">
        <header className="board-header">
          <h1>Sprint Board</h1>
        </header>
        <p className="muted" style={{ padding: 20 }}>
          The sprint board is a dev-only tool; its API is served by Vite
          during local development and isn't deployed. Run <code>npm run dev</code> locally to edit tasks.
        </p>
      </div>
    )
  }

  return (
    <div className="board board-embedded">
      <header className="board-header">
        <h1>Sprint Board</h1>
      </header>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={({ active }) => setActiveId(active.id)}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="columns">
          {COLUMNS.map((col) => (
            <Column
              key={col.id}
              column={col}
              tasks={byColumn[col.id] ?? []}
              onAdd={() => addTask(col.id)}
              onOpen={(t) => setEditing(t)}
            />
          ))}
        </div>
        <DragOverlay>{activeTask ? <Card task={activeTask} overlay /> : null}</DragOverlay>
      </DndContext>

      {editing && (
        <Editor task={editing} onClose={() => setEditing(null)} onSave={saveTask} onDelete={deleteTask} />
      )}
    </div>
  )
}

function Column({ column, tasks, onAdd, onOpen }) {
  const { setNodeRef } = useSortable({ id: column.id, data: { type: 'column' } })
  return (
    <div className="column">
      <div className="column-header">
        <h2>{column.title}</h2>
        <span className="count">{tasks.length}</span>
      </div>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="column-body" data-column-id={column.id}>
          {tasks.map((t) => (
            <SortableCard key={t.id} task={t} onOpen={() => onOpen(t)} />
          ))}
          {tasks.length === 0 && <div className="empty">Drop tasks here</div>}
        </div>
      </SortableContext>
      <button className="add-btn" onClick={onAdd}>+ Add task</button>
    </div>
  )
}

function SortableCard({ task, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} onClick={onOpen}>
      <Card task={task} />
    </div>
  )
}

function Card({ task, overlay }) {
  return (
    <div className={`card${overlay ? ' overlay' : ''}`}>
      <div className="card-title">{task.title}</div>
      {task.body && <div className="card-body">{task.body.split('\n')[0]}</div>}
    </div>
  )
}

function Editor({ task, onClose, onSave, onDelete }) {
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState(task.body)
  const [status, setStatus] = useState(task.status)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <input className="modal-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {COLUMNS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <textarea
          className="modal-body"
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Task details in markdown..."
        />
        <div className="modal-actions">
          <button onClick={() => onDelete(task.id)} className="danger">Delete</button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={() => onSave({ ...task, title, body, status })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

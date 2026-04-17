import { useEffect, useRef, useState } from 'react'

export default function Chat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [streaming, setStreaming] = useState(false)
  const scrollRef = useRef(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, open])

  async function send() {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', content: text }])
    setStreaming(true)

    const assistantIdx = messages.length + 1
    setMessages((m) => [...m, { role: 'assistant', content: '', events: [] }])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId }),
      })
      if (!res.ok || !res.body) throw new Error(await res.text())

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const ev = {}
          for (const line of part.split('\n')) {
            const m = line.match(/^(event|data): (.*)$/)
            if (m) ev[m[1]] = m[2]
          }
          if (!ev.event) continue
          const data = JSON.parse(ev.data ?? 'null')
          handleEvent(ev.event, data, assistantIdx)
        }
      }
    } catch (e) {
      setMessages((m) => {
        const copy = [...m]
        copy[assistantIdx] = {
          role: 'assistant',
          content: `Error: ${e.message}`,
          events: [],
        }
        return copy
      })
    } finally {
      setStreaming(false)
    }
  }

  function handleEvent(event, data, idx) {
    if (event === 'session') setSessionId(data.sessionId)
    else if (event === 'text') {
      setMessages((m) => {
        const copy = [...m]
        const cur = copy[idx] ?? { role: 'assistant', content: '', events: [] }
        copy[idx] = { ...cur, content: (cur.content ?? '') + data.text }
        return copy
      })
    } else if (event === 'tool_use') {
      setMessages((m) => {
        const copy = [...m]
        const cur = copy[idx] ?? { role: 'assistant', content: '', events: [] }
        copy[idx] = {
          ...cur,
          events: [...(cur.events ?? []), { type: 'tool', name: data.name, input: data.input }],
        }
        return copy
      })
    } else if (event === 'error') {
      setMessages((m) => {
        const copy = [...m]
        const cur = copy[idx] ?? { role: 'assistant', content: '', events: [] }
        copy[idx] = { ...cur, content: (cur.content ?? '') + `\n\n⚠ ${data.message}` }
        return copy
      })
    }
  }

  return (
    <>
      <button className="chat-fab" onClick={() => setOpen((o) => !o)} title="Chat with Claude">
        {open ? '×' : '💬'}
      </button>
      {open && (
        <div className="chat-panel">
          <div className="chat-header">
            <div>
              <strong>Claude</strong>
              <span className="chat-status">● connected</span>
            </div>
            <button onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="chat-body" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="chat-empty">
                Ask Claude to change docs, tasks, diagrams, or references in this project.
              </div>
            )}
            {messages.map((m, i) => (
              <Message key={i} message={m} />
            ))}
          </div>
          <div className="chat-input">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="Ask Claude to edit something…"
              rows={2}
              disabled={streaming}
            />
            <button onClick={send} disabled={streaming || !input.trim()}>
              {streaming ? '…' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function Message({ message }) {
  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-bubble">{message.content}</div>
      </div>
    )
  }
  return (
    <div className="msg assistant">
      {message.events?.map((ev, i) => (
        <div key={i} className="msg-tool">
          <span className="tool-name">{ev.name}</span>
          <span className="tool-args">{summarizeToolInput(ev.name, ev.input)}</span>
        </div>
      ))}
      {message.content && <div className="msg-bubble">{message.content}</div>}
    </div>
  )
}

function summarizeToolInput(name, input) {
  if (!input) return ''
  if (input.file_path) return input.file_path.split('/').slice(-2).join('/')
  if (input.pattern) return input.pattern
  if (input.command) return input.command.slice(0, 60)
  return ''
}

import { useEffect, useRef, useState } from 'react'
import { Client } from 'colyseus.js'

export function useSandboxRoom({ url, roomName }) {
  const [status, setStatus] = useState('idle')
  const [state, setState] = useState({ agents: [], messages: [], width: 16, height: 12 })
  const [error, setError] = useState(null)
  const roomRef = useRef(null)

  useEffect(() => {
    if (!url) return
    let cancelled = false
    setStatus('connecting')
    setError(null)

    const client = new Client(url)
    client
      .joinOrCreate('sandbox', { roomName, name: 'observer', isAgent: false })
      .then((room) => {
        if (cancelled) { try { room.leave() } catch {} ; return }
        roomRef.current = room
        setStatus('connected')
        const sync = () => {
          const agents = []
          const a = room.state?.agents
          if (a && typeof a.forEach === 'function') {
            a.forEach((p, sid) => {
              agents.push({
                sessionId: sid,
                name: p?.name ?? '',
                npub: p?.npub ?? '',
                isAgent: !!p?.isAgent,
                joinedAt: p?.joinedAt ?? 0,
                x: p?.x ?? 0,
                y: p?.y ?? 0,
              })
            })
          }
          const m = room.state?.messages
          const messages = (m && typeof m.map === 'function')
            ? m.map((x) => ({ ts: x.ts, from: x.from, fromNpub: x.fromNpub, text: x.text }))
            : []
          setState({
            agents,
            messages,
            width: room.state?.width ?? 16,
            height: room.state?.height ?? 12,
          })
        }
        room.onStateChange(sync)
        sync()
        room.onLeave(() => setStatus('disconnected'))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message || String(err))
        setStatus('error')
      })

    return () => {
      cancelled = true
      const room = roomRef.current
      roomRef.current = null
      if (room) { try { room.leave() } catch {} }
    }
  }, [url, roomName])

  return { status, state, error }
}

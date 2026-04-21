import { useEffect, useState } from 'react'

export function useAgentEvents({ bridgeUrl, agentId }) {
  const [events, setEvents] = useState([])
  const [status, setStatus] = useState('idle')

  useEffect(() => {
    if (!bridgeUrl || !agentId) return
    setEvents([])
    setStatus('connecting')

    const url = `${bridgeUrl}/agents/${agentId}/events/stream`
    const es = new EventSource(url)

    es.addEventListener('backlog', (e) => {
      try {
        const backlog = JSON.parse(e.data)
        setEvents(Array.isArray(backlog) ? backlog : [])
        setStatus('connected')
      } catch {}
    })

    es.addEventListener('event', (e) => {
      try {
        const ev = JSON.parse(e.data)
        setEvents((prev) => [...prev, ev])
      } catch {}
    })

    es.onerror = () => setStatus('error')

    return () => { try { es.close() } catch {} }
  }, [bridgeUrl, agentId])

  return { events, status }
}

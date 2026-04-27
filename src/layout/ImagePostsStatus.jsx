import { useEffect, useState } from 'react'

const POLL_MS = 30_000

export default function ImagePostsStatus({ bridgeUrl, active }) {
  const [snap, setSnap] = useState(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!bridgeUrl) return
    let cancelled = false
    async function tick() {
      try {
        const r = await fetch(`${bridgeUrl}/image-posts/status`)
        if (!r.ok) throw new Error(String(r.status))
        const json = await r.json()
        if (!cancelled) { setSnap(json); setErr(false) }
      } catch {
        if (!cancelled) setErr(true)
      }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [bridgeUrl])

  const count = snap?.count ?? 0
  const title = err
    ? 'Image posts unreachable'
    : count > 0
      ? `${count} image post${count === 1 ? '' : 's'}${snap?.latest_actor_name ? ` · latest from ${snap.latest_actor_name}` : ''}`
      : 'No image posts yet'

  return (
    <a
      href="#/image-posts"
      className={`sidebar-link image-posts-status${active ? ' active' : ''}`}
      title={title}
    >
      <span className="image-posts-label">Image Posts</span>
      {count > 0 && <span className="image-posts-count">{count}</span>}
    </a>
  )
}

import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'

export default function Reference({ id }) {
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/references/readme?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content)
        setLoading(false)
      })
  }, [id])

  return (
    <div className="doc-content">
      <h3 style={{ color: '#888', fontSize: 12, textTransform: 'uppercase', margin: '0 0 8px' }}>
        references / {id}
      </h3>
      {loading ? (
        <p>Loading…</p>
      ) : content ? (
        <ReactMarkdown>{content}</ReactMarkdown>
      ) : (
        <p>No README found in this reference.</p>
      )}
    </div>
  )
}

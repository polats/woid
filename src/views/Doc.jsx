import ReactMarkdown from 'react-markdown'

export default function Doc({ content }) {
  if (!content) return <p style={{ padding: 32 }}>No document selected.</p>
  return (
    <div className="doc-content">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  )
}

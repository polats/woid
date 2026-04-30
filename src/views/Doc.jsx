import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function Doc({ content, cta }) {
  if (!content) return <p style={{ padding: 32 }}>No document selected.</p>
  return (
    <div className="doc-content">
      {cta}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}

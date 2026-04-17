import { useState } from 'react'

const TOKEN_URL = 'https://github.com/settings/tokens/new?description=woid&scopes=repo,read:user'

export default function LoginModal({ onClose, onSuccess }) {
  const [token, setToken] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/github/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) throw new Error(await res.text())
      onSuccess(await res.json())
    } catch (e) {
      setErr(String(e.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0 }}>Login with GitHub</h2>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
          <li>
            <a href={TOKEN_URL} target="_blank" rel="noreferrer">Generate a token on GitHub</a>{' '}
            (scopes <code>repo</code> + <code>read:user</code> are pre-selected).
          </li>
          <li>Copy the token and paste it below.</li>
        </ol>
        <input
          type="password"
          placeholder="ghp_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="modal-title"
          autoFocus
        />
        {err && <div style={{ color: '#c00', fontSize: 13 }}>{err}</div>}
        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!token || busy} onClick={submit}>
            {busy ? 'Verifying…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import config from './config.js'
import { useRelayFeed } from './hooks/useRelayFeed.js'
import { profileUrl, eventUrl } from './lib/jumble.js'

const cfg = config.agentSandbox || {}

export default function RelayFeed() {
  const { events, status } = useRelayFeed({ url: cfg.relayUrl, kinds: [0, 1], limit: 100 })
  const [characters, setCharacters] = useState([])
  const [adminInfo, setAdminInfo] = useState(null)

  useEffect(() => {
    if (!cfg.bridgeUrl) return
    fetch(`${cfg.bridgeUrl}/admin`).then((r) => r.json()).then(setAdminInfo).catch(() => {})
    const load = () =>
      fetch(`${cfg.bridgeUrl}/characters`)
        .then((r) => r.json())
        .then((j) => setCharacters(j.characters || []))
        .catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  const npubToName = new Map()
  for (const c of characters) if (c.pubkey) npubToName.set(c.pubkey, c.name)
  if (adminInfo?.pubkey) npubToName.set(adminInfo.pubkey, adminInfo.profile?.name || 'Administrator')

  const adminEventCount = adminInfo?.pubkey
    ? events.filter((e) => e.pubkey === adminInfo.pubkey).length
    : 0

  function copy(text) {
    try { navigator.clipboard?.writeText(text) } catch {}
  }

  return (
    <div className="relay-feed-view">
      <header>
        <h1>Nostr Relay</h1>
        <div className="relay-feed-meta">
          <code>{cfg.relayUrl}</code>
          <span className={`status status-${status}`}>{status}</span>
          <span className="muted">{events.length} events</span>
        </div>
      </header>

      <div className="relay-feed-info">
        <div className="agent-sandbox-info-cell">
          <span className="agent-sandbox-info-label">Admin</span>
          <div className="agent-sandbox-info-val">
            {adminInfo ? (
              <>
                <strong>{adminInfo.profile?.name || 'Administrator'}</strong>
                <code title={adminInfo.pubkey}>{adminInfo.npub?.slice(0, 16)}…</code>
                <button className="agent-sandbox-info-copy" onClick={() => copy(adminInfo.npub)}>
                  copy
                </button>
                {profileUrl(cfg.jumbleUrl, adminInfo.npub || adminInfo.pubkey) && (
                  <a
                    className="relay-feed-jumble-link"
                    href={profileUrl(cfg.jumbleUrl, adminInfo.npub || adminInfo.pubkey)}
                    target="_blank"
                    rel="noreferrer"
                    title="Open on Jumble"
                  >
                    jumble ↗
                  </a>
                )}
              </>
            ) : <span className="muted">loading…</span>}
          </div>
        </div>
        <div className="agent-sandbox-info-cell">
          <span className="agent-sandbox-info-label">Characters</span>
          <div className="agent-sandbox-info-val">
            <strong>{characters.length}</strong>
            <span className="muted">· {characters.filter((c) => c.runtime?.running).length} running</span>
          </div>
        </div>
        <div className="agent-sandbox-info-cell">
          <span className="agent-sandbox-info-label">Events</span>
          <div className="agent-sandbox-info-val">
            <strong>{events.length}</strong>
            <span className="muted">· {adminEventCount} from admin</span>
          </div>
        </div>
      </div>

      {events.length === 0 ? (
        <p className="muted">Waiting for events…</p>
      ) : (
        <ul className="relay-feed-list">
          {events.map((ev) => {
            const isProfile = ev.kind === 0
            let profile = null
            if (isProfile) {
              try { profile = JSON.parse(ev.content) } catch {}
            }
            const authorJumble = profileUrl(cfg.jumbleUrl, ev.pubkey)
            const eventJumble = eventUrl(cfg.jumbleUrl, ev.id, {
              author: ev.pubkey,
              kind: ev.kind,
              relays: cfg.relayUrl ? [cfg.relayUrl] : [],
            })
            return (
              <li key={ev.id} className={isProfile ? 'relay-feed-item-profile' : ''}>
                <div className="relay-feed-author">
                  {authorJumble ? (
                    <a href={authorJumble} target="_blank" rel="noreferrer" className="relay-feed-author-link" title="Open author on Jumble">
                      <strong>{npubToName.get(ev.pubkey) || ev.pubkey.slice(0, 10) + '…'}</strong>
                    </a>
                  ) : (
                    <strong>{npubToName.get(ev.pubkey) || ev.pubkey.slice(0, 10) + '…'}</strong>
                  )}
                  <span className="relay-feed-kind">kind:{ev.kind}</span>
                  <time dateTime={new Date(ev.created_at * 1000).toISOString()}>
                    {new Date(ev.created_at * 1000).toLocaleTimeString()}
                  </time>
                  {eventJumble && (
                    <a
                      className="relay-feed-jumble-link"
                      href={eventJumble}
                      target="_blank"
                      rel="noreferrer"
                      title="Open event on Jumble"
                    >
                      jumble ↗
                    </a>
                  )}
                </div>
                {isProfile ? (
                  <div className="relay-feed-profile">
                    {profile?.picture && (
                      <img src={profile.picture} alt={profile.name || ev.pubkey.slice(0, 8)} />
                    )}
                    <div>
                      <div><strong>{profile?.name ?? '(no name)'}</strong></div>
                      {profile?.about && <div className="muted">{profile.about}</div>}
                    </div>
                  </div>
                ) : (
                  <div className="relay-feed-content">{ev.content}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

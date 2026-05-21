import { useEffect, useState, useCallback } from 'react'
import config from '../config.js'
import {
  isAvailable as gemmaAvailable,
  modelStatus as gemmaModelStatus,
  downloadModel as gemmaDownloadModel,
  initModel as gemmaInitModel,
  generate as gemmaGenerate,
  DEFAULT_MODEL_URL as GEMMA_DEFAULT_URL,
} from '../lib/gemmaLocal.js'
import {
  isAvailable as imagenAvailable,
  modelStatus as imagenModelStatus,
  downloadModel as imagenDownloadModel,
  initModel as imagenInitModel,
  generate as imagenGenerate,
  fileSrcForWebview,
  DEFAULT_MODEL_URL as IMAGEN_DEFAULT_URL,
} from '../lib/imagenLocal.js'

const PERSONA_PROMPT = (
  'You generate game NPCs for a shelter management game. Reply with ONLY a JSON object ' +
  'matching {"name": "<character name>", "about": "<1-2 sentences>"}. No commentary, no markdown.\n\n' +
  'Generate one persona now.'
)

// Pulls the most recent {name, about} object out of Gemma's streamed
// output. Tolerant of trailing prose and code fences.
function parsePersona(text) {
  if (!text) return null
  const m = String(text).match(/\{[\s\S]*?"about"[\s\S]*?\}/)
  if (!m) return null
  try { const o = JSON.parse(m[0]); if (o && o.name && o.about) return o } catch { /* ignore */ }
  return null
}

// FNV-1a 32-bit hash → stable seed so the same persona always yields
// the same face on re-generate.
function seedFromString(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

// Compose an AbsoluteReality-friendly portrait prompt. AR is a
// SD 1.5 photographic finetune — quality tags + a photographic
// vocabulary land much better than painterly directives, and the
// negative prompt steers it away from anime / cgi drift.
function buildAvatarPrompt(persona) {
  const name = persona?.name || 'an unnamed shelter survivor'
  const about = persona?.about || 'a weathered survivor of a long underground winter'
  const prompt = [
    `portrait photograph of ${name}`,
    about,
    'close-up headshot, 3/4 view, soft natural window light, neutral background',
    'detailed eyes, realistic skin texture, dirt and stubble, post-apocalyptic shelter survivor',
    'photorealistic, 50mm lens, shallow depth of field, sharp focus',
    'masterpiece, best quality, ultra-detailed, 8k',
  ].join(', ')
  const negativePrompt = [
    'worst quality', 'low quality', 'normal quality', 'lowres', 'blurry', 'out of focus',
    'cartoon', 'anime', 'cgi', 'drawing', 'painting', 'illustration', '3d render',
    'deformed', 'extra fingers', 'extra limbs', 'bad anatomy', 'bad hands',
    'watermark', 'signature', 'text', 'logo', 'pixelated', 'duplicate',
  ].join(', ')
  const seed = seedFromString(`${name}|${about}`)
  return { prompt, negativePrompt, seed }
}

function fmtBytes(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i]
}

const PAGE = 50

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

export default function Personas() {
  const bridgeUrl = config.agentSandbox?.bridgeUrl
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [nextCursor, setNextCursor] = useState(null)
  const [selected, setSelected] = useState(null)
  const [status, setStatus] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  // Local on-device Gemma surface. Only renders on the Capacitor build
  // — gemmaAvailable() returns false on web so the whole block is hidden.
  const [hasGemma, setHasGemma] = useState(() => gemmaAvailable())
  const [gemmaModel, setGemmaModel] = useState(null) // { present, sizeBytes, loaded }
  const [gemmaBusy, setGemmaBusy] = useState(false)
  const [gemmaPhase, setGemmaPhase] = useState('idle') // idle | download | init | generate | done | error
  const [gemmaProgress, setGemmaProgress] = useState(null) // { got, total, bytesPerSec }
  const [gemmaOutput, setGemmaOutput] = useState('')
  const [gemmaError, setGemmaError] = useState(null)
  const [gemmaLastMs, setGemmaLastMs] = useState(null)

  // Imagen (on-device image generation) — independent surface from Gemma.
  const [hasImagen, setHasImagen] = useState(() => imagenAvailable())
  const [imagenModel, setImagenModel] = useState(null)
  const [imagenBusy, setImagenBusy] = useState(false)
  const [imagenPhase, setImagenPhase] = useState('idle')
  const [imagenProgress, setImagenProgress] = useState(null)
  const [imagenStep, setImagenStep] = useState(null) // { step, total }
  const [imagenImagePath, setImagenImagePath] = useState(null)
  const [imagenLastMs, setImagenLastMs] = useState(null)
  const [imagenError, setImagenError] = useState(null)
  const [imagenIsPlaceholder, setImagenIsPlaceholder] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.Capacitor) return
    let cancelled = false
    const id = setInterval(async () => {
      if (cancelled) return
      if (!gemmaAvailable()) return
      clearInterval(id)
      setHasGemma(true)
      try { setGemmaModel(await gemmaModelStatus()) } catch { /* ignore */ }
    }, 250)
    setTimeout(() => clearInterval(id), 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  async function refreshGemmaStatus() {
    try { setGemmaModel(await gemmaModelStatus()) } catch { /* ignore */ }
  }

  useEffect(() => {
    if (typeof window === 'undefined' || !window.Capacitor) return
    let cancelled = false
    const id = setInterval(async () => {
      if (cancelled) return
      if (!imagenAvailable()) return
      clearInterval(id)
      setHasImagen(true)
      try { setImagenModel(await imagenModelStatus()) } catch { /* ignore */ }
    }, 250)
    setTimeout(() => clearInterval(id), 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  async function refreshImagenStatus() {
    try { setImagenModel(await imagenModelStatus()) } catch { /* ignore */ }
  }

  async function runGenerateAvatar() {
    if (!hasImagen || imagenBusy) return
    setImagenBusy(true)
    setImagenError(null)
    setImagenImagePath(null)
    setImagenLastMs(null)
    setImagenStep(null)
    try {
      // Trigger downloadModel if EITHER the SD weights or the TAESD
      // decoder are missing. The plugin is idempotent per-file, so an
      // already-downloaded SD model isn't re-fetched — only the
      // missing piece comes down (TAESD is ~5 MB).
      if (!imagenModel?.present || !imagenModel?.taesdPresent) {
        setImagenPhase('download')
        await imagenDownloadModel(IMAGEN_DEFAULT_URL, (p) => setImagenProgress(p))
        await refreshImagenStatus()
      }
      if (!imagenModel?.loaded) {
        setImagenPhase('init')
        await imagenInitModel()
        await refreshImagenStatus()
      }
      setImagenPhase('generate')
      // Pull the persona Gemma just produced (if any) so the avatar
      // reflects this specific NPC. Falls back to a generic survivor
      // if no persona has been generated yet in this session.
      const persona = parsePersona(gemmaOutput)
      const { prompt, negativePrompt, seed } = buildAvatarPrompt(persona)
      console.log('[Imagen] persona=' + JSON.stringify(persona) + ' gemmaOutputLen=' + (gemmaOutput?.length || 0))
      console.log('[Imagen] prompt=' + prompt)
      console.log('[Imagen] seed=' + seed)
      const done = await imagenGenerate(
        { prompt, negativePrompt, steps: 20, width: 512, height: 512, seed },
        (e) => setImagenStep(e),
      )
      setImagenImagePath(done.path)
      setImagenLastMs(done.ms ?? null)
      setImagenIsPlaceholder(!!done.placeholder)
      setImagenPhase('done')
    } catch (e) {
      setImagenError(e.message || String(e))
      setImagenPhase('error')
    } finally {
      setImagenBusy(false)
    }
  }

  async function runGeneratePersona() {
    if (!hasGemma || gemmaBusy) return
    setGemmaBusy(true)
    setGemmaError(null)
    setGemmaOutput('')
    setGemmaLastMs(null)
    try {
      // 1. Download if needed.
      if (!gemmaModel?.present) {
        setGemmaPhase('download')
        await gemmaDownloadModel(GEMMA_DEFAULT_URL, (p) => setGemmaProgress(p))
        await refreshGemmaStatus()
      }
      // 2. Init MediaPipe if needed.
      if (!gemmaModel?.loaded) {
        setGemmaPhase('init')
        await gemmaInitModel()
        await refreshGemmaStatus()
      }
      // 3. Generate.
      setGemmaPhase('generate')
      let buf = ''
      const done = await gemmaGenerate(PERSONA_PROMPT, (ev) => {
        buf += ev.delta
        setGemmaOutput(buf)
      })
      setGemmaLastMs(done?.ms ?? null)
      setGemmaPhase('done')
    } catch (e) {
      setGemmaError(e.message || String(e))
      setGemmaPhase('error')
    } finally {
      setGemmaBusy(false)
    }
  }

  const refresh = useCallback(async (c = 0) => {
    if (!bridgeUrl) return
    try {
      const r = await fetch(`${bridgeUrl}/v1/personas/log?limit=${PAGE}&cursor=${c}`)
      if (!r.ok) throw new Error(String(r.status))
      const json = await r.json()
      setItems(json.items || [])
      setTotal(json.total ?? 0)
      setNextCursor(json.nextCursor)
      setCursor(c)
      setLoadErr(null)
    } catch (e) {
      setLoadErr(e.message || String(e))
    }
  }, [bridgeUrl])

  useEffect(() => { refresh(0) }, [refresh])

  useEffect(() => {
    if (!bridgeUrl) return
    let cancelled = false
    async function tick() {
      try {
        const r = await fetch(`${bridgeUrl}/v1/personas/status`)
        if (!r.ok) return
        const json = await r.json()
        if (!cancelled) setStatus(json)
      } catch { /* ignore */ }
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [bridgeUrl])

  async function openRow(id) {
    try {
      const r = await fetch(`${bridgeUrl}/v1/personas/log/${id}`)
      if (!r.ok) throw new Error(String(r.status))
      setSelected(await r.json())
    } catch (e) {
      setSelected({ id, error: e.message || String(e) })
    }
  }

  // On mobile the bridge isn't reachable (no LAN server), but the
  // on-device test surface still has value — so we only hard-stop on
  // missing bridge when neither local AI surface is available.
  if (!bridgeUrl && !hasGemma && !hasImagen) return <p style={{ padding: 32 }}>Bridge URL not configured.</p>

  const q = status?.quota
  const recent = status?.recent

  return (
    <div className="personas-view" style={{ padding: 24, display: 'flex', gap: 24, height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <h1 style={{ marginTop: 0 }}>Persona generations</h1>

        {hasGemma && (
          <div
            style={{
              marginBottom: 16, padding: 14, borderRadius: 10,
              border: '1px solid #2a3a5a', background: 'rgba(122, 162, 255, 0.08)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                  background: '#7aa2ff', boxShadow: '0 0 6px rgba(122,162,255,0.6)',
                }}
                aria-hidden="true"
              />
              <strong>Local Gemma (on-device)</strong>
              <span style={{ opacity: 0.7, fontSize: 12 }}>
                Gemma 4 E2B · MediaPipe LlmInference
                {gemmaModel?.present && (
                  <> · model {fmtBytes(gemmaModel.sizeBytes)}{gemmaModel.loaded ? ' · loaded' : ' · not loaded'}</>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={runGeneratePersona}
                disabled={gemmaBusy}
                style={{
                  padding: '6px 14px', borderRadius: 6, cursor: gemmaBusy ? 'wait' : 'pointer',
                  background: '#7aa2ff', color: '#0a0a0c', border: 'none', fontWeight: 600,
                }}
              >
                {gemmaBusy ? 'Working…' : (gemmaModel?.present ? 'Generate persona' : 'Download model + generate')}
              </button>
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                phase: <code>{gemmaPhase}</code>
                {gemmaLastMs != null && <> · last gen <code>{gemmaLastMs}ms</code></>}
              </span>
            </div>
            {gemmaPhase === 'download' && gemmaProgress && (
              <div style={{ marginTop: 10 }}>
                <div style={{ height: 8, background: '#1a1a22', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: gemmaProgress.total ? `${(gemmaProgress.got / gemmaProgress.total) * 100}%` : '5%',
                      background: '#7aa2ff', transition: 'width 0.2s',
                    }}
                  />
                </div>
                <div style={{ fontSize: 12, marginTop: 4, opacity: 0.8 }}>
                  {fmtBytes(gemmaProgress.got)} / {fmtBytes(gemmaProgress.total)}
                  {gemmaProgress.bytesPerSec ? <> · {fmtBytes(gemmaProgress.bytesPerSec)}/s</> : null}
                </div>
              </div>
            )}
            {gemmaPhase === 'init' && (
              <p style={{ fontSize: 12, marginTop: 8, opacity: 0.8 }}>Loading model into MediaPipe… (5–15s)</p>
            )}
            {gemmaOutput && (
              <pre
                style={{
                  marginTop: 10, padding: 10, borderRadius: 6,
                  background: '#0a0a0c', color: '#cfe', fontSize: 13,
                  whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto',
                }}
              >
                {gemmaOutput}
                {gemmaPhase === 'generate' && <span style={{ opacity: 0.6 }}> ▌</span>}
              </pre>
            )}
            {gemmaError && (
              <p style={{ color: '#f88', fontSize: 13, marginTop: 8 }}>error: {gemmaError}</p>
            )}
          </div>
        )}

        {hasImagen && (
          <div
            style={{
              marginBottom: 16, padding: 14, borderRadius: 10,
              border: '1px solid #5a3a5a', background: 'rgba(255, 122, 200, 0.07)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                  background: '#ff7ac8', boxShadow: '0 0 6px rgba(255,122,200,0.6)',
                }}
                aria-hidden="true"
              />
              <strong>Local Imagen (on-device)</strong>
              <span style={{ opacity: 0.7, fontSize: 12 }}>
                Step 1: bridge + UI plumbing (placeholder image). Step 2 wires real stable-diffusion.cpp.
                {imagenModel?.present && (
                  <> · model {fmtBytes(imagenModel.sizeBytes)}{imagenModel.loaded ? ' · loaded' : ' · not loaded'}</>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={runGenerateAvatar}
                disabled={imagenBusy}
                style={{
                  padding: '6px 14px', borderRadius: 6, cursor: imagenBusy ? 'wait' : 'pointer',
                  background: '#ff7ac8', color: '#0a0a0c', border: 'none', fontWeight: 600,
                }}
              >
                {imagenBusy ? 'Working…' : (imagenModel?.present ? 'Generate avatar' : 'Download model + generate')}
              </button>
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                phase: <code>{imagenPhase}</code>
                {imagenStep && imagenPhase === 'generate' && <> · step <code>{imagenStep.step}/{imagenStep.total}</code></>}
                {imagenLastMs != null && <> · last <code>{imagenLastMs}ms</code></>}
              </span>
            </div>
            {imagenPhase === 'download' && imagenProgress && (
              imagenProgress.phase === 'extracting' ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    Extracting model bundle… {imagenProgress.filesExtracted ?? 0} files
                  </div>
                  <div style={{ height: 8, background: '#1a1a22', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                    {/* Indeterminate stripe — extract finishes in seconds */}
                    <div style={{
                      height: '100%', width: '40%',
                      background: 'linear-gradient(90deg, transparent, #ff7ac8, transparent)',
                      animation: 'imagen-extract-stripe 1.2s infinite linear',
                    }} />
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <div style={{ height: 8, background: '#1a1a22', borderRadius: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: imagenProgress.total ? `${(imagenProgress.got / imagenProgress.total) * 100}%` : '5%',
                        background: '#ff7ac8', transition: 'width 0.2s',
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4, opacity: 0.8 }}>
                    Downloading · {fmtBytes(imagenProgress.got)} / {fmtBytes(imagenProgress.total)}
                    {imagenProgress.bytesPerSec ? <> · {fmtBytes(imagenProgress.bytesPerSec)}/s</> : null}
                  </div>
                </div>
              )
            )}
            {imagenPhase === 'init' && (
              <p style={{ fontSize: 12, marginTop: 8, opacity: 0.8 }}>Loading diffusion context…</p>
            )}
            {imagenPhase === 'generate' && imagenStep && (
              <div style={{ marginTop: 10 }}>
                <div style={{ height: 6, background: '#1a1a22', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${(imagenStep.step / imagenStep.total) * 100}%`,
                      background: '#ff7ac8', transition: 'width 0.15s',
                    }}
                  />
                </div>
              </div>
            )}
            {imagenImagePath && (
              <div style={{ marginTop: 10 }}>
                <img
                  src={fileSrcForWebview(imagenImagePath)}
                  alt="generated avatar"
                  style={{
                    width: 256, height: 256, borderRadius: 8,
                    border: '1px solid #3a2a3a', objectFit: 'cover',
                  }}
                />
                {imagenIsPlaceholder && (
                  <p style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                    Placeholder render — replaced by stable-diffusion.cpp output in Step 2.
                  </p>
                )}
              </div>
            )}
            {imagenError && (
              <p style={{ color: '#f88', fontSize: 13, marginTop: 8 }}>error: {imagenError}</p>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 24, fontSize: 13, marginBottom: 12, flexWrap: 'wrap' }}>
          <div>
            <strong>Rate limit:</strong>{' '}
            {q ? `${q.currentTokens} / ${q.perMinute} available (per min)` : '—'}
          </div>
          <div>
            <strong>24h:</strong>{' '}
            {recent ? `${recent.ok24h} ok / ${recent.fail24h} failed` : '—'}
            {recent?.p50ms != null && <span style={{ opacity: 0.6 }}> · p50 {recent.p50ms}ms</span>}
          </div>
        </div>

        {loadErr && <p style={{ color: 'crimson' }}>Failed to load log: {loadErr}</p>}

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
              <th style={{ padding: '6px 8px' }}>When</th>
              <th style={{ padding: '6px 8px' }}>Model</th>
              <th style={{ padding: '6px 8px' }}>Name</th>
              <th style={{ padding: '6px 8px' }}>Status</th>
              <th style={{ padding: '6px 8px' }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr
                key={row.id}
                onClick={() => openRow(row.id)}
                style={{
                  cursor: 'pointer',
                  borderBottom: '1px solid #eee',
                  background: selected?.id === row.id ? 'var(--paper-3, #f3f3f3)' : 'transparent',
                }}
              >
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmtTime(row.ts)}</td>
                <td style={{ padding: '6px 8px' }}><code>{row.model || '—'}</code></td>
                <td style={{ padding: '6px 8px' }}>{row.name || ''}</td>
                <td style={{ padding: '6px 8px', color: row.ok ? '#2da14a' : '#c83b3b' }}>
                  {row.ok ? 'ok' : `fail: ${(row.error || '').slice(0, 60)}`}
                </td>
                <td style={{ padding: '6px 8px' }}>{row.durationMs}ms</td>
              </tr>
            ))}
            {items.length === 0 && !loadErr && (
              <tr><td colSpan={5} style={{ padding: 12, opacity: 0.6 }}>No generations yet.</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => refresh(Math.max(0, cursor - PAGE))}
            disabled={cursor === 0}
          >
            ← Newer
          </button>
          <button
            type="button"
            onClick={() => nextCursor != null && refresh(nextCursor)}
            disabled={nextCursor == null}
          >
            Older →
          </button>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {total} total · showing {cursor + 1}–{cursor + items.length}
          </span>
          <button type="button" onClick={() => refresh(cursor)} style={{ marginLeft: 'auto' }}>
            Refresh
          </button>
        </div>
      </div>

      <aside
        style={{
          width: 380,
          flexShrink: 0,
          borderLeft: '1px solid #ddd',
          paddingLeft: 16,
          overflow: 'auto',
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Detail</h2>
        {!selected && <p style={{ opacity: 0.6, fontSize: 13 }}>Click a row to inspect.</p>}
        {selected && (
          <div style={{ fontSize: 13 }}>
            <div><strong>id:</strong> <code>{selected.id}</code></div>
            <div><strong>ts:</strong> {fmtTime(selected.ts)}</div>
            {selected.model && <div><strong>model:</strong> <code>{selected.model}</code></div>}
            {selected.durationMs != null && <div><strong>duration:</strong> {selected.durationMs}ms</div>}
            {selected.seedHash && <div><strong>seed hash:</strong> <code>{selected.seedHash}</code></div>}
            {selected.name && <div><strong>name:</strong> {selected.name}</div>}
            {selected.npub && (
              <div>
                <strong>npub:</strong> <code style={{ fontSize: 11 }}>{selected.npub.slice(0, 16)}…</code>
              </div>
            )}
            {selected.jumbleUrl && (
              <div style={{ marginTop: 4 }}>
                <a href={selected.jumbleUrl} target="_blank" rel="noreferrer">View on Jumble →</a>
              </div>
            )}
            {selected.about && (
              <div style={{ marginTop: 8 }}>
                <strong>about:</strong>
                <p style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{selected.about}</p>
              </div>
            )}
            {selected.imageUrl && (
              <div style={{ marginTop: 8 }}>
                <strong>image:</strong>
                <div style={{ marginTop: 4 }}>
                  <img
                    src={selected.imageUrl}
                    alt="generated avatar"
                    style={{ maxWidth: '100%', border: '1px solid #ddd' }}
                  />
                </div>
              </div>
            )}
            {selected.error && (
              <div style={{ marginTop: 8, color: '#c83b3b' }}>
                <strong>error:</strong> {selected.error}
              </div>
            )}
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.7 }}>Raw JSON</summary>
              <pre style={{ fontSize: 11, overflow: 'auto', marginTop: 4 }}>
                {JSON.stringify(selected, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </aside>
    </div>
  )
}

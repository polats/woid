// Vite dev middleware that proxies /api/kimodo/* to the local kimodo HTTP API
// (default: http://localhost:7862, override via KIMODO_URL env var). Keeps
// the browser on a single origin and gives us one place to swap the URL.
//
// /generate is exposed *both* as a passthrough (POST /api/kimodo/generate
// → kimodo /generate) AND as an SSE wrapper (GET /api/kimodo/generate/stream
// → polls /animations until the new id appears, emits stage events). The
// SSE variant gives the UI nicer progress feedback while the model warms up.

import { request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { URL } from 'node:url'

const KIMODO_URL = process.env.KIMODO_URL || 'http://localhost:7862'

function proxyOnce(req, res, targetPath) {
  return new Promise((resolve) => {
    const url = new URL(targetPath, KIMODO_URL)
    const opts = {
      method: req.method,
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      headers: { ...req.headers, host: url.host },
    }
    const upstream = httpRequest(opts, (up) => {
      res.statusCode = up.statusCode || 502
      for (const [k, v] of Object.entries(up.headers)) res.setHeader(k, v)
      up.pipe(res)
      up.on('end', resolve)
    })
    upstream.on('error', (err) => {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'kimodo unreachable', detail: String(err.message || err), kimodoUrl: KIMODO_URL }))
      resolve()
    })
    req.pipe(upstream)
  })
}

async function kimodoFetch(path, init = {}) {
  const r = await fetch(`${KIMODO_URL}${path}`, init)
  if (!r.ok) throw new Error(`kimodo ${path}: HTTP ${r.status}`)
  return r.json()
}

export function kimodoApi() {
  return {
    name: 'kimodo-api',
    configureServer(server) {
      // Streaming generate — gives nicer UX while the model warms up + runs.
      server.middlewares.use('/api/kimodo/generate/stream', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end('Method Not Allowed'); return
        }
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders?.()
        const send = (event, data) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

        let aborted = false
        res.on('close', () => { aborted = true })

        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const body = Buffer.concat(chunks).toString('utf8') || '{}'

          send('stage', { stage: 'starting', message: 'sending to kimodo…' })
          // Kick off the generation. kimodo /generate blocks until done and
          // returns the saved id, so this is a single long-lived call.
          const startedAt = Date.now()
          const heartbeat = setInterval(() => {
            if (aborted) return
            send('heartbeat', { elapsedMs: Date.now() - startedAt })
          }, 1000)

          let result
          try {
            const r = await fetch(`${KIMODO_URL}/generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            })
            if (!r.ok) {
              const text = await r.text().catch(() => '')
              throw new Error(`kimodo /generate HTTP ${r.status}: ${text.slice(0, 200)}`)
            }
            result = await r.json()
          } finally {
            clearInterval(heartbeat)
          }

          if (aborted) return
          send('done', { animation: result })
          res.end()
        } catch (e) {
          send('error', { message: String(e?.message ?? e) })
          res.end()
        }
      })

      // Static GLB fallback. The kimodo motion API on :7862 serves JSON
      // (animations, characters) but NOT the unirig character GLBs — those
      // live under web/public/models/ inside the demo container. Stream
      // them out via `docker exec cat`. Filename is whitelisted to prevent
      // path traversal.
      server.middlewares.use('/api/kimodo/models', async (req, res) => {
        const filename = (req.url || '').replace(/^\//, '').split('?')[0]
        if (!/^[A-Za-z0-9_.-]+\.glb$/.test(filename)) {
          res.statusCode = 400; res.end('bad filename'); return
        }
        const containerPath = `/workspace/web/public/models/${filename}`
        const cat = spawn('docker', ['exec', 'demo', 'cat', containerPath])
        let headersSent = false
        cat.stdout.on('data', (chunk) => {
          if (!headersSent) {
            res.statusCode = 200
            res.setHeader('Content-Type', 'model/gltf-binary')
            res.setHeader('Cache-Control', 'public, max-age=600')
            headersSent = true
          }
          res.write(chunk)
        })
        cat.stderr.on('data', (e) => console.warn('[kimodo/models]', filename, e.toString().trim()))
        cat.on('close', (code) => {
          if (!headersSent) {
            res.statusCode = code === 0 ? 502 : 404
            res.end(code === 0 ? 'empty' : `not found in container (exit ${code})`)
          } else {
            res.end()
          }
        })
        cat.on('error', (err) => {
          if (!headersSent) {
            res.statusCode = 500
            res.end(`docker exec failed: ${err.message}`)
          } else {
            res.end()
          }
        })
      })

      // Generic passthrough for everything else under /api/kimodo/*. Strips
      // the prefix and forwards method, headers, and body.
      server.middlewares.use('/api/kimodo', async (req, res) => {
        // Express-style middleware: req.url here is the path *after* /api/kimodo.
        const target = req.url || '/'
        await proxyOnce(req, res, target)
      })
    },
  }
}

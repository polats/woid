import fs from 'node:fs/promises'
import path from 'node:path'
import { createReadStream } from 'node:fs'

const ROOT = path.resolve(process.cwd(), 'testing/sessions')

const MIME = {
  '.webm': 'video/webm',
  '.mp4':  'video/mp4',
  '.json': 'application/json',
  '.md':   'text/markdown; charset=utf-8',
}

export function testingApi() {
  return {
    name: 'testing-api',
    configureServer(server) {
      server.middlewares.use('/api/testing/sessions', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://x')
          const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''))

          // /api/testing/sessions → manifest
          if (rel === '' || rel === '/') {
            const manifest = path.join(ROOT, 'manifest.json')
            try {
              const body = await fs.readFile(manifest, 'utf8')
              res.setHeader('Content-Type', 'application/json')
              res.end(body)
            } catch {
              res.setHeader('Content-Type', 'application/json')
              res.end('[]')
            }
            return
          }

          // Prevent path traversal.
          const abs = path.join(ROOT, rel)
          if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) {
            res.statusCode = 403
            res.end('forbidden')
            return
          }

          const stat = await fs.stat(abs).catch(() => null)
          if (!stat || !stat.isFile()) {
            res.statusCode = 404
            res.end('not found')
            return
          }

          const ext = path.extname(abs).toLowerCase()
          res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
          res.setHeader('Content-Length', stat.size)
          res.setHeader('Accept-Ranges', 'bytes')
          createReadStream(abs).pipe(res)
        } catch (err) {
          res.statusCode = 500
          res.end(String(err?.message || err))
        }
      })
    },
  }
}

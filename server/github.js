import fs from 'node:fs/promises'
import path from 'node:path'
import { readBody } from './frontmatter.js'

export const TOKEN_FILE = path.resolve(process.cwd(), '.github-token')

export async function readToken() {
  try {
    return (await fs.readFile(TOKEN_FILE, 'utf8')).trim()
  } catch {
    return null
  }
}

export function githubApi() {
  return {
    name: 'github-api',
    configureServer(server) {
      server.middlewares.use('/api/github', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://x')

          if (req.method === 'POST' && url.pathname === '/token') {
            const { token } = await readBody(req)
            if (!token || typeof token !== 'string') throw new Error('missing token')
            const ghRes = await fetch('https://api.github.com/user', {
              headers: { Authorization: `Bearer ${token.trim()}`, 'User-Agent': 'woid' },
            })
            if (!ghRes.ok) {
              res.statusCode = 401
              res.end('Invalid token')
              return
            }
            await fs.writeFile(TOKEN_FILE, token.trim() + '\n', { mode: 0o600 })
            const user = await ghRes.json()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ login: user.login, name: user.name, avatar_url: user.avatar_url }))
            return
          }

          if (req.method === 'GET' && url.pathname === '/me') {
            const token = await readToken()
            if (!token) return res.end('null')
            const ghRes = await fetch('https://api.github.com/user', {
              headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'woid' },
            })
            if (!ghRes.ok) return res.end('null')
            const user = await ghRes.json()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ login: user.login, name: user.name, avatar_url: user.avatar_url }))
            return
          }

          if (req.method === 'DELETE' && url.pathname === '/token') {
            await fs.unlink(TOKEN_FILE).catch(() => {})
            res.end('{"ok":true}')
            return
          }

          res.statusCode = 404
          res.end('Not Found')
        } catch (e) {
          res.statusCode = 500
          res.end(String(e.message ?? e))
        }
      })
    },
  }
}

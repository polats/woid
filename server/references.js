import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readBody } from './frontmatter.js'
import { readToken } from './github.js'

const pExecFile = promisify(execFile)
const ROOT = process.cwd()
const REFERENCES_DIR = path.resolve(ROOT, 'references')

function parseRepoInput(input) {
  const s = input.trim().replace(/\.git$/, '')
  let m = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/i)
  if (m) return { owner: m[1], repo: m[2] }
  m = s.match(/^git@github\.com:([^/]+)\/([^/]+?)\/?$/i)
  if (m) return { owner: m[1], repo: m[2] }
  m = s.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (m) return { owner: m[1], repo: m[2] }
  return null
}

async function findReadme(dir) {
  try {
    const files = await fs.readdir(dir)
    const readme = files.find((f) => /^readme(\.md|\.markdown)?$/i.test(f))
    if (!readme) return null
    return await fs.readFile(path.join(dir, readme), 'utf8')
  } catch {
    return null
  }
}

async function listSubmodules() {
  try {
    const { stdout } = await pExecFile(
      'git',
      ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
      { cwd: ROOT },
    )
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [key, val] = line.split(' ')
        const name = key.replace(/^submodule\./, '').replace(/\.path$/, '')
        return { name, path: val }
      })
      .filter((m) => m.path.startsWith('references/'))
  } catch {
    return []
  }
}

export function referencesApi() {
  return {
    name: 'references-api',
    configureServer(server) {
      server.middlewares.use('/api/references', async (req, res) => {
        try {
          await fs.mkdir(REFERENCES_DIR, { recursive: true })
          const url = new URL(req.url, 'http://x')

          if (req.method === 'GET' && url.pathname === '/') {
            const mods = await listSubmodules()
            const items = mods.map((m) => ({
              id: m.path.replace(/^references\//, ''),
              path: m.path,
              name: m.name,
            }))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(items))
            return
          }

          if (req.method === 'GET' && url.pathname === '/readme') {
            const id = url.searchParams.get('id')
            if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('bad id')
            const content = await findReadme(path.join(REFERENCES_DIR, id))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ id, content }))
            return
          }

          if (req.method === 'POST' && url.pathname === '/') {
            const { input } = await readBody(req)
            const parsed = parseRepoInput(input ?? '')
            if (!parsed) throw new Error('Enter a GitHub URL or owner/repo')
            const { owner, repo } = parsed
            const id = `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
            const subPath = `references/${id}`
            const cleanUrl = `https://github.com/${owner}/${repo}.git`
            const token = await readToken()
            const cloneUrl = token ? `https://oauth2:${token}@github.com/${owner}/${repo}.git` : cleanUrl

            try {
              await pExecFile('git', ['submodule', 'add', '--', cloneUrl, subPath], { cwd: ROOT })
            } catch (e) {
              const msg = String(e.stderr ?? e.message ?? e).replace(token ?? '__none__', '***')
              res.statusCode = 400
              res.end(msg)
              return
            }

            if (token) {
              await pExecFile('git', ['config', '-f', '.gitmodules', `submodule.${subPath}.url`, cleanUrl], { cwd: ROOT })
              await pExecFile('git', ['config', `submodule.${subPath}.url`, cleanUrl], { cwd: ROOT }).catch(() => {})
              await pExecFile('git', ['submodule', 'sync', '--', subPath], { cwd: ROOT }).catch(() => {})
            }

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ id, path: subPath }))
            return
          }

          if (req.method === 'DELETE' && url.pathname === '/') {
            const { id } = await readBody(req)
            if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('bad id')
            const subPath = `references/${id}`
            await pExecFile('git', ['submodule', 'deinit', '-f', '--', subPath], { cwd: ROOT }).catch(() => {})
            await pExecFile('git', ['rm', '-f', '--', subPath], { cwd: ROOT }).catch(() => {})
            await fs.rm(path.join(ROOT, '.git/modules', subPath), { recursive: true, force: true }).catch(() => {})
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

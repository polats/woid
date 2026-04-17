import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter, stringifyFrontmatter, readBody } from './frontmatter.js'

const TASKS_DIR = path.resolve(process.cwd(), 'tasks')

export function tasksApi() {
  return {
    name: 'tasks-api',
    configureServer(server) {
      server.middlewares.use('/api/tasks', async (req, res) => {
        try {
          await fs.mkdir(TASKS_DIR, { recursive: true })

          if (req.method === 'GET') {
            const files = (await fs.readdir(TASKS_DIR)).filter((f) => f.endsWith('.md'))
            const tasks = await Promise.all(
              files.map(async (f) => {
                const raw = await fs.readFile(path.join(TASKS_DIR, f), 'utf8')
                const { data, body } = parseFrontmatter(raw)
                return {
                  id: f.replace(/\.md$/, ''),
                  title: data.title ?? f.replace(/\.md$/, ''),
                  status: data.status ?? 'todo',
                  order: typeof data.order === 'number' ? data.order : 0,
                  body: body.trim(),
                }
              }),
            )
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(tasks))
            return
          }

          if (req.method === 'PUT') {
            const { id, title, status, order, body } = await readBody(req)
            if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad id')
            const out = stringifyFrontmatter(
              { title, status, order },
              (body ?? '').trim() + '\n',
            )
            await fs.writeFile(path.join(TASKS_DIR, `${id}.md`), out, 'utf8')
            res.end('{"ok":true}')
            return
          }

          if (req.method === 'POST') {
            const { title, status } = await readBody(req)
            const id = `${Date.now()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'}`
            const out = stringifyFrontmatter(
              { title, status: status ?? 'todo', order: Date.now() },
              '\n',
            )
            await fs.writeFile(path.join(TASKS_DIR, `${id}.md`), out, 'utf8')
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ id }))
            return
          }

          if (req.method === 'DELETE') {
            const { id } = await readBody(req)
            if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad id')
            await fs.unlink(path.join(TASKS_DIR, `${id}.md`))
            res.end('{"ok":true}')
            return
          }

          res.statusCode = 405
          res.end('Method Not Allowed')
        } catch (e) {
          res.statusCode = 500
          res.end(String(e.message ?? e))
        }
      })
    },
  }
}

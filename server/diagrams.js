import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter, stringifyFrontmatter, readBody } from './frontmatter.js'

const DIAGRAMS_DIR = path.resolve(process.cwd(), 'diagrams')
const safeId = (id) => /^[A-Za-z0-9_-]+$/.test(id)

function extractDiagram(body) {
  const m = body.match(/```json\n([\s\S]*?)\n```/)
  if (!m) return { nodes: [], edges: [] }
  try {
    const d = JSON.parse(m[1])
    return { nodes: d.nodes ?? [], edges: d.edges ?? [] }
  } catch {
    return { nodes: [], edges: [] }
  }
}

export function diagramsApi() {
  return {
    name: 'diagrams-api',
    configureServer(server) {
      server.middlewares.use('/api/diagrams', async (req, res) => {
        try {
          await fs.mkdir(DIAGRAMS_DIR, { recursive: true })
          const url = new URL(req.url, 'http://x')
          const id = url.searchParams.get('id')

          if (req.method === 'GET' && !id) {
            const files = (await fs.readdir(DIAGRAMS_DIR)).filter((f) => f.endsWith('.md'))
            const list = await Promise.all(
              files.map(async (f) => {
                const raw = await fs.readFile(path.join(DIAGRAMS_DIR, f), 'utf8')
                const { data } = parseFrontmatter(raw)
                const fid = f.replace(/\.md$/, '')
                return { id: fid, title: data.title ?? fid }
              }),
            )
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(list))
            return
          }

          if (req.method === 'GET' && id) {
            if (!safeId(id)) throw new Error('bad id')
            const raw = await fs.readFile(path.join(DIAGRAMS_DIR, `${id}.md`), 'utf8')
            const { data, body } = parseFrontmatter(raw)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ id, title: data.title ?? id, ...extractDiagram(body) }))
            return
          }

          if (req.method === 'PUT') {
            const { id, title, nodes, edges } = await readBody(req)
            if (!safeId(id)) throw new Error('bad id')
            const body = `\n\`\`\`json\n${JSON.stringify({ nodes, edges }, null, 2)}\n\`\`\`\n`
            const out = stringifyFrontmatter({ title }, body)
            await fs.writeFile(path.join(DIAGRAMS_DIR, `${id}.md`), out, 'utf8')
            res.end('{"ok":true}')
            return
          }

          if (req.method === 'POST') {
            const { title } = await readBody(req)
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'diagram'
            const newId = `${Date.now()}-${slug}`
            const body = `\n\`\`\`json\n${JSON.stringify({ nodes: [], edges: [] }, null, 2)}\n\`\`\`\n`
            const out = stringifyFrontmatter({ title }, body)
            await fs.writeFile(path.join(DIAGRAMS_DIR, `${newId}.md`), out, 'utf8')
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ id: newId }))
            return
          }

          if (req.method === 'DELETE') {
            const { id: delId } = await readBody(req)
            if (!safeId(delId)) throw new Error('bad id')
            await fs.unlink(path.join(DIAGRAMS_DIR, `${delId}.md`))
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

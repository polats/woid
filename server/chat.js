import { readBody } from './frontmatter.js'

const ROOT = process.cwd()

export function chatApi() {
  return {
    name: 'chat-api',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res) => {
        try {
          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ authenticated: true, mode: 'claude-code' }))
            return
          }

          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method Not Allowed')
            return
          }

          const { message, sessionId } = await readBody(req)
          if (!message || typeof message !== 'string') throw new Error('missing message')

          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          res.flushHeaders?.()

          const send = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          }

          let aborted = false
          req.on('close', () => {
            aborted = true
          })

          try {
            const { query } = await import('@anthropic-ai/claude-agent-sdk')
            const options = {
              cwd: ROOT,
              allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
              permissionMode: 'acceptEdits',
            }
            if (sessionId) options.resume = sessionId

            const q = query({ prompt: message, options })
            for await (const msg of q) {
              if (aborted) break
              if (msg.type === 'system' && msg.subtype === 'init') {
                send('session', { sessionId: msg.session_id })
              } else if (msg.type === 'assistant') {
                for (const b of msg.message?.content ?? []) {
                  if (b.type === 'text') send('text', { text: b.text })
                  else if (b.type === 'tool_use')
                    send('tool_use', { name: b.name, input: b.input })
                }
              } else if (msg.type === 'user') {
                for (const b of msg.message?.content ?? []) {
                  if (b.type === 'tool_result') {
                    const content =
                      typeof b.content === 'string'
                        ? b.content
                        : Array.isArray(b.content)
                        ? b.content.map((x) => x.text ?? '').join('')
                        : ''
                    send('tool_result', { content: content.slice(0, 2000), isError: b.is_error })
                  }
                }
              } else if (msg.type === 'result') {
                send('done', { result: msg.result, isError: msg.is_error, cost: msg.total_cost_usd })
              }
            }
          } catch (e) {
            send('error', { message: String(e.message ?? e) })
          }

          res.end()
        } catch (e) {
          res.statusCode = 500
          res.end(String(e.message ?? e))
        }
      })
    },
  }
}

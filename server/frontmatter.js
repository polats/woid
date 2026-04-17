export function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: raw }
  const data = {}
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (m) {
      let v = m[2].trim()
      if (/^-?\d+$/.test(v)) v = Number(v)
      else if (v === 'true' || v === 'false') v = v === 'true'
      else v = v.replace(/^['"]|['"]$/g, '')
      data[m[1]] = v
    }
  }
  return { data, body: match[2] }
}

export function stringifyFrontmatter(data, body) {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

export async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

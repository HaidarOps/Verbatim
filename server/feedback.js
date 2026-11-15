// Feedback box endpoint. Runs in the Vite dev/preview server (see
// vite.config.js).
//   POST /api/feedback  { message }  -> appends one JSON line to feedback/feedback.jsonl
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const MAX_MESSAGE = 2000

export function feedbackMiddleware(dir) {
  return (req, res) => {
    const reply = (code, body) => {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') return reply(405, { error: 'POST only' })

    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 20000) req.destroy()
    })
    req.on('end', async () => {
      try {
        const message = String(JSON.parse(raw).message ?? '').trim().slice(0, MAX_MESSAGE)
        if (!message) return reply(400, { error: 'Empty message' })
        await mkdir(dir, { recursive: true })
        const line = JSON.stringify({ at: new Date().toISOString(), message })
        await appendFile(path.join(dir, 'feedback.jsonl'), line + '\n')
        reply(200, { ok: true })
      } catch {
        reply(400, { error: 'Bad request' })
      }
    })
  }
}

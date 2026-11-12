// Whole-book translation scan with a cheap OpenAI model. Runs in the Vite
// dev/preview server (see vite.config.js) so the API key never reaches the
// browser.
//
//   POST /api/scan  { book, pairs: [{ key, original, translation }] }
//        -> { model, results: { [key]: { score, kind, issue } } }
//   GET  /api/scan?book=<id>
//        -> { model, results }  (everything scanned so far)
//
// The page sends batches of aligned sentence pairs; each batch is one OpenAI
// request. Results are cached on disk in scans/<book>.<model>.json, keyed by
// the page's hash of the pair's text, so a pair is only ever paid for once
// and an interrupted scan resumes where it stopped.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
export const DEFAULT_SCAN_MODEL = 'gpt-5-nano'
const MAX_PAIRS = 40 // per request
const MAX_SIDE_CHARS = 1500 // per side of a pair; longer text is truncated
const KINDS = ['good', 'translation_issue', 'not_matching']

const SYSTEM_PROMPT = `You review a published translation of a book, one aligned
passage pair at a time. Each pair has an id, the ORIGINAL passage and the
TRANSLATION passage. The languages may be anything; identify them yourself.

The pairs were matched automatically by sentence length, so some pairs do not
actually correspond (the translation of this passage is elsewhere). Mark those
kind "not_matching" with score 1.

Otherwise score fidelity and naturalness from 1 to 10:
9-10 faithful and natural; 7-8 minor losses or liberties;
4-6 meaning partly lost, added or distorted; 1-3 largely wrong.
Use kind "good" for scores 7-10, "translation_issue" for 1-6.

"issue": at most 15 words naming the main problem and the words involved;
empty string when kind is "good". Return one result for every id.`

const RESPONSE_SCHEMA = {
  name: 'translation_scan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'score', 'kind', 'issue'],
          properties: {
            id: { type: 'string' },
            score: { type: 'integer' },
            kind: { type: 'string', enum: KINDS },
            issue: { type: 'string' },
          },
        },
      },
    },
  },
}

export class ScanError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const clip = (s) => {
  const t = typeof s === 'string' ? s.trim() : ''
  return t.length > MAX_SIDE_CHARS ? `${t.slice(0, MAX_SIDE_CHARS)}…` : t
}

// Rate a batch of pairs in one request. Returns { [key]: result } for the
// pairs the model answered; pairs it skipped are simply absent (retry later).
// Reasoning models (GPT-5 family, o-series) otherwise spend hundreds of
// hidden, billed "reasoning" tokens per pair on this simple scoring task.
const REASONING_MODEL = /^(gpt-5|o\d)/
export const DEFAULT_SCAN_REASONING = 'minimal'

export async function scanBatch(pairs, { apiKey, model, reasoning, fetchImpl = fetch }) {
  if (!apiKey) {
    throw new ScanError(
      500,
      'No OpenAI API key. Add OPENAI_API_KEY=… to .env.local in the project folder and restart npm run dev.',
    )
  }
  if (!Array.isArray(pairs) || pairs.length === 0) throw new ScanError(400, 'No pairs to scan.')
  if (pairs.length > MAX_PAIRS) throw new ScanError(400, `At most ${MAX_PAIRS} pairs per request.`)

  // Short ids keep the prompt small; map them back to the page's keys.
  const byId = new Map()
  const blocks = pairs.map((p, i) => {
    const id = `p${i + 1}`
    byId.set(id, p.key)
    return `[${id}]\nORIGINAL: ${clip(p.original)}\nTRANSLATION: ${clip(p.translation)}`
  })

  const useModel = model || DEFAULT_SCAN_MODEL
  const res = await fetchImpl(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: useModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: blocks.join('\n\n') },
      ],
      response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
      ...(REASONING_MODEL.test(useModel) ? { reasoning_effort: reasoning || DEFAULT_SCAN_REASONING } : {}),
    }),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const detail = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`
    throw new ScanError(502, `OpenAI request failed: ${detail}`)
  }
  const message = data && data.choices && data.choices[0] && data.choices[0].message
  let parsed
  try {
    parsed = JSON.parse(message.content)
  } catch {
    throw new ScanError(502, 'OpenAI returned an unreadable answer.')
  }

  const out = {}
  for (const r of Array.isArray(parsed.results) ? parsed.results : []) {
    const key = byId.get(r.id)
    if (!key) continue
    out[key] = {
      score: Math.min(10, Math.max(1, Math.round(Number(r.score) || 1))),
      kind: KINDS.includes(r.kind) ? r.kind : 'translation_issue',
      issue: String(r.issue || '').slice(0, 200),
    }
  }
  return { results: out, usage: data.usage || null }
}

// ---------------------------------------------------------------------------
// On-disk cache: scans/<book>.<model>.json = { model, results: { key: r } }
// ---------------------------------------------------------------------------

export function createScanStore(dir) {
  const cache = new Map() // file -> Promise<{ model, results }>
  const queues = new Map() // file -> Promise (serialises writes)
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_') // no dots, slashes, …
  const fileFor = (book, model) => path.join(dir, `${safe(book)}.${safe(model)}.json`)

  function load(book, model) {
    const file = fileFor(book, model)
    if (!cache.has(file)) {
      cache.set(
        file,
        readFile(file, 'utf8')
          .then((t) => JSON.parse(t))
          .catch(() => ({ model, results: {} })),
      )
    }
    return cache.get(file)
  }

  async function save(book, model, newResults) {
    const file = fileFor(book, model)
    const prev = queues.get(file) || Promise.resolve()
    const next = prev.then(async () => {
      const data = await load(book, model)
      Object.assign(data.results, newResults)
      await mkdir(dir, { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(data))
      await rename(tmp, file)
    })
    queues.set(file, next.catch(() => {}))
    return next
  }

  return { load, save }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function scanMiddleware(getConfig, store) {
  return async (req, res, next) => {
    const send = (status, body) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }
    try {
      const config = getConfig()
      const model = config.model || DEFAULT_SCAN_MODEL
      if (req.method === 'GET') {
        const book = new URL(req.url, 'http://x').searchParams.get('book')
        if (!book) throw new ScanError(400, 'Missing ?book=')
        const data = await store.load(book, model)
        return send(200, { model, results: data.results })
      }
      if (req.method !== 'POST') return next()

      let body
      try {
        body = JSON.parse(await readBody(req, 512 * 1024))
      } catch (err) {
        throw err instanceof ScanError ? err : new ScanError(400, 'Request body must be JSON.')
      }
      const book = body && body.book
      if (!book || !Array.isArray(body.pairs)) throw new ScanError(400, 'Expected { book, pairs }.')

      // Only pay for pairs not scanned before.
      const cached = (await store.load(book, model)).results
      const todo = body.pairs.filter((p) => p && p.key && !cached[p.key])
      let fresh = {}
      let usage = null
      if (todo.length) {
        ;({ results: fresh, usage } = await scanBatch(todo, config))
        await store.save(book, model, fresh)
      }
      const results = {}
      for (const p of body.pairs) {
        const r = fresh[p.key] || cached[p.key]
        if (r) results[p.key] = r
      }
      send(200, { model, results, usage })
    } catch (err) {
      send(err instanceof ScanError ? err.status : 500, { error: err.message || String(err) })
    }
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new ScanError(413, 'Request too large.'))
        req.destroy()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

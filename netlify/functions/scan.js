// Netlify Function for GET/POST /api/scan (see netlify.toml's /api/*
// redirect). Same request handling as scanMiddleware in
// server/scanTranslations.js, adapted to Netlify's Request/Response
// signature and backed by Netlify Blobs instead of local disk (see
// _blobStore.js) — a Netlify Function has no persistent local filesystem
// shared across invocations.
import { DEFAULT_SCAN_MODEL, ScanError, scanBatch } from '../../server/scanTranslations.js'
import { createBlobStore } from './_blobStore.js'

const store = createBlobStore('scans')

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async (req) => {
  const config = {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_SCAN_MODEL,
    reasoning: process.env.OPENAI_SCAN_REASONING,
  }
  const model = config.model || DEFAULT_SCAN_MODEL
  try {
    if (req.method === 'GET') {
      const book = new URL(req.url).searchParams.get('book')
      if (!book) throw new ScanError(400, 'Missing ?book=')
      const data = await store.load(book, model)
      return json(200, { model, results: data.results })
    }
    if (req.method !== 'POST') return json(405, { error: 'POST only' })

    let body
    try {
      body = await req.json()
    } catch {
      throw new ScanError(400, 'Request body must be JSON.')
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
    return json(200, { model, results, usage })
  } catch (err) {
    return json(err instanceof ScanError ? err.status : 500, { error: err.message || String(err) })
  }
}

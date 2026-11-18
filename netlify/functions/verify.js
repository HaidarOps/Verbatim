// Netlify Function for GET/POST /api/verify (see netlify.toml's /api/*
// redirect). Same request handling as verifyMiddleware in
// server/verifyIssues.js, adapted to Netlify's Request/Response signature
// and backed by Netlify Blobs instead of local disk (see _blobStore.js).
// Shares the 'scans' blob store with scan.js; the verify-<model> label keeps
// its entries apart, exactly as the on-disk store named its files.
import { DEFAULT_VERIFY_MODEL, VerifyError, verifyBatch } from '../../server/verifyIssues.js'
import { createBlobStore } from './_blobStore.js'

const store = createBlobStore('scans')

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async (req) => {
  const config = {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_VERIFY_MODEL || process.env.OPENAI_MODEL,
    reasoning: process.env.OPENAI_VERIFY_REASONING,
  }
  const model = config.model || DEFAULT_VERIFY_MODEL
  const label = `verify-${model}` // keep these verdicts in their own blob
  try {
    if (req.method === 'GET') {
      const book = new URL(req.url).searchParams.get('book')
      if (!book) throw new VerifyError(400, 'Missing ?book=')
      const data = await store.load(book, label)
      return json(200, { model, results: data.results })
    }
    if (req.method !== 'POST') return json(405, { error: 'POST only' })

    let body
    try {
      body = await req.json()
    } catch {
      throw new VerifyError(400, 'Request body must be JSON.')
    }
    const book = body && body.book
    if (!book || !Array.isArray(body.pairs)) throw new VerifyError(400, 'Expected { book, pairs }.')

    // Only pay for pairs not verified before.
    const cached = (await store.load(book, label)).results
    const todo = body.pairs.filter((p) => p && p.key && !cached[p.key])
    let fresh = {}
    let usage = null
    if (todo.length) {
      ;({ results: fresh, usage } = await verifyBatch(todo, config))
      await store.save(book, label, fresh)
    }
    const results = {}
    for (const p of body.pairs) {
      const r = fresh[p.key] || cached[p.key]
      if (r) results[p.key] = r
    }
    return json(200, { model, results, usage })
  } catch (err) {
    return json(err instanceof VerifyError ? err.status : 500, { error: err.message || String(err) })
  }
}

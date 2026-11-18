// Netlify Function for POST /api/rate-translation (see netlify.toml's
// /api/* redirect). Thin HTTP adapter around the same rateTranslation() used
// by the Vite dev server (server/rateTranslation.js); only the request/
// response plumbing differs (Fetch API Request/Response here, Node's
// req/res there). The API key is read from the site's environment variables
// (Netlify dashboard → Site configuration → Environment variables), never
// shipped to the browser.
import { RatingError, rateTranslation } from '../../server/rateTranslation.js'

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  let body
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'Request body must be JSON.' })
  }
  try {
    const result = await rateTranslation(body || {}, {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
    })
    return json(200, result)
  } catch (err) {
    return json(err instanceof RatingError ? err.status : 500, { error: err.message || String(err) })
  }
}

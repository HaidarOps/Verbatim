// Rates a translation with the OpenAI API. Runs in the Vite dev/preview
// server (see vite.config.js), never in the browser, so the API key stays on
// this machine: the page POSTs { original, translation } to
// /api/rate-translation and gets back { score, summary, issues }.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const DEFAULT_MODEL = 'gpt-5-mini'
const MAX_CHARS = 4000 // per side; a highlighted passage is a few sentences

const SYSTEM_PROMPT = `You are an expert literary translator and reviewer.
You are given a passage from a book (the original) and the passage a published
translation aligned to it. The two may be in any languages; identify them
yourself. Judge how faithful and natural the translation is.

Score from 1 to 10:
10 = faithful in meaning, tone and register, and natural in the target language.
7-9 = good, with minor losses or liberties.
4-6 = meaning partly lost, added or distorted, or noticeably awkward.
1-3 = largely wrong, or does not correspond to the original at all.

The passages were matched automatically by sentence length, so they may not
correspond. If they clearly do not, give a score of 1 and say so in the summary.

List the specific problems, quoting the exact words from each side. Note
omissions (target_words empty) and additions (source_words empty). If the
translation is excellent, issues may be empty. Write the summary and problems
in English.`

const RESPONSE_SCHEMA = {
  name: 'translation_rating',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['score', 'source_language', 'target_language', 'summary', 'issues'],
    properties: {
      score: { type: 'integer', description: '1 (poor) to 10 (excellent)' },
      source_language: { type: 'string' },
      target_language: { type: 'string' },
      summary: { type: 'string', description: 'One or two sentences.' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['source_words', 'target_words', 'problem'],
          properties: {
            source_words: { type: 'string', description: 'Exact words from the original, or empty.' },
            target_words: { type: 'string', description: 'Exact words from the translation, or empty.' },
            problem: { type: 'string', description: 'What is wrong and what would be better.' },
          },
        },
      },
    },
  },
}

export class RatingError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// Ask the model to rate one passage pair. `fetchImpl` is injectable for tests.
export async function rateTranslation({ original, translation }, { apiKey, model, fetchImpl = fetch }) {
  if (!apiKey) {
    throw new RatingError(
      500,
      'No OpenAI API key. Add OPENAI_API_KEY=… to .env.local in the project folder and restart npm run dev.',
    )
  }
  const clean = (s) => (typeof s === 'string' ? s.trim() : '')
  const src = clean(original)
  const tgt = clean(translation)
  if (!src || !tgt) throw new RatingError(400, 'Both the original and the translation are required.')
  if (src.length > MAX_CHARS || tgt.length > MAX_CHARS) {
    throw new RatingError(400, `Passage too long (max ${MAX_CHARS} characters per side). Select less text.`)
  }

  const res = await fetchImpl(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `ORIGINAL:\n${src}\n\nTRANSLATION:\n${tgt}` },
      ],
      response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
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
    throw new RatingError(502, `OpenAI request failed: ${detail}`)
  }

  const message = data && data.choices && data.choices[0] && data.choices[0].message
  if (message && message.refusal) throw new RatingError(502, `The model declined: ${message.refusal}`)
  let rating
  try {
    rating = JSON.parse(message.content)
  } catch {
    throw new RatingError(502, 'OpenAI returned an unreadable answer. Try again.')
  }
  const score = Math.min(10, Math.max(1, Math.round(Number(rating.score) || 1)))
  return {
    score,
    sourceLanguage: String(rating.source_language || ''),
    targetLanguage: String(rating.target_language || ''),
    summary: String(rating.summary || ''),
    issues: Array.isArray(rating.issues)
      ? rating.issues.map((i) => ({
          sourceWords: String(i.source_words || ''),
          targetWords: String(i.target_words || ''),
          problem: String(i.problem || ''),
        }))
      : [],
  }
}

// Connect-style middleware for POST /api/rate-translation.
export function rateTranslationMiddleware(getConfig) {
  return async (req, res, next) => {
    if (req.method !== 'POST') return next()
    const send = (status, body) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }
    try {
      const raw = await readBody(req, 64 * 1024)
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        throw new RatingError(400, 'Request body must be JSON.')
      }
      send(200, await rateTranslation(body || {}, getConfig()))
    } catch (err) {
      send(err instanceof RatingError ? err.status : 500, { error: err.message || String(err) })
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
        reject(new RatingError(413, 'Request too large.'))
        req.destroy()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

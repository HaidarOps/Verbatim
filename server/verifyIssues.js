// Confirm the Gale–Church red signals with a strong OpenAI model. Runs in the
// Vite dev/preview server (see vite.config.js) so the API key never reaches the
// browser.
//
//   POST /api/verify  { book, pairs: [{ key, original, translation, flag,
//                       before_a, after_a, before_b, after_b }] }
//        -> { model, results: { [key]: { verdict, severity, reason, expected } } }
//   where before_*/after_* are the neighbouring sentences on each side (context
//   so the model can tell an off-by-one slip from a real divergence), and
//   `expected` is, for an error, a plain-English gist for a reader who knows
//   neither language. The model decides which side is the original — it is not
//   assumed to be PASSAGE A.
//   GET  /api/verify?book=<id>
//        -> { model, results }  (everything verified so far)
//
// Only the passages Gale–Church already flagged are sent here (see candidates
// in src/issues.js), so this is a small, targeted second opinion rather than a
// whole-book scan. Each pair is judged by a capable model (gpt-5-mini by
// default, NOT the cheap scan model) and labelled:
//   alignment_error    the two passages don't correspond AND nothing nearby does
//                      (a real divergence — omitted/added/restructured)
//   translation_error  they correspond, but the translation is seriously wrong
//                      (a real omission, addition or distortion)
//   misaligned         they don't correspond, but the true counterpart is an
//                      adjacent sentence — our matcher slipped (a tool glitch,
//                      not a fault in the book; hidden from readers)
//   fine               Gale–Church was suspicious, but the pair is acceptable
// alignment_error and translation_error are the reader-facing confirmed issues;
// "misaligned" is dev-only noise and "fine" clears the flag.
//
// Results are cached on disk in scans/<book>.verify-<model>.json, keyed by the
// page's hash of the pair's text, so a pair is only ever paid for once and the
// verdicts can be committed and shipped — the reader then shows them with no
// API call (createScanStore is shared with server/scanTranslations.js).

import { createScanStore } from './scanTranslations.js'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
export const DEFAULT_VERIFY_MODEL = 'gpt-5-mini'
const MAX_PAIRS = 20 // per request; these passages are the long, suspicious ones
const MAX_SIDE_CHARS = 2000 // per side of a pair; longer text is truncated
const MAX_CONTEXT_CHARS = 700 // per neighbour-context block
const VERDICTS = ['alignment_error', 'translation_error', 'misaligned', 'fine']

const SYSTEM_PROMPT = `You are an expert literary translator auditing how two
editions of the same work line up. A fast heuristic (and sometimes a quick AI
read) flagged the passage pairs below; confirm or clear each by reading it. Each
pair has an id, a "flag" naming why it was suspicious, and two passages —
PASSAGE A and PASSAGE B — the span our matcher paired, each from one edition, in
different languages. To help you judge, a few neighbouring sentences from each
edition are given as CONTEXT BEFORE / CONTEXT AFTER — the lines around the
passage in that edition. The context is for reference only; it is NOT part of
the pair being judged.

Identify each language yourself. Do NOT assume which side is the original; for
many works the classical or source-language side (Greek, Latin, French,
Russian, …) is the original and the English is the translation. Decide from the
languages and content.

Work out whether PASSAGE A and PASSAGE B are the same span of the story, then
give one verdict:
- "misaligned": A and B are NOT the same span, but B's true counterpart is right
  next to A — it is one of A's CONTEXT sentences (just before or after). Our
  matcher slipped by a sentence or two; the content is present, only shifted.
  This is a tool glitch, not a fault in the book. In "reason", say which way it
  slipped (e.g. "B matches the sentence after A").
- "alignment_error": A and B are not the same span AND B's counterpart is NOT in
  the context shown either — the passage genuinely has no nearby counterpart
  (truly omitted or added, or the editions diverge here).
- "translation_error": A and B ARE the same span, but the translation is
  seriously wrong — a real omission, addition, or distortion of meaning.
- "fine": they are the same span and the translation is acceptable (minor
  liberties ok).
Prefer "misaligned" over "alignment_error" whenever a context sentence clearly
matches. Be strict with "translation_error": reserve it for clear, significant
faults. When unsure between fine and an error, answer "fine".

For each result give:
- "severity": 1-5, how bad the problem is (5 = egregious); 0 when the verdict is "fine".
- "reason": at most 20 words naming the problem (for "misaligned", the slip direction); empty when "fine".
- "expected": for an error, a plain-English gist for a reader who knows NEITHER
  language — name the language of each side ("The Greek says…; the English
  says…"). For a translation_error, say what the source passage actually means
  and what the translation gets wrong or leaves out. For an alignment_error or
  misaligned, say in one line what each passage is about. Empty string when the
  verdict is "fine".
Return exactly one result for every id.`

const RESPONSE_SCHEMA = {
  name: 'issue_verification',
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
          required: ['id', 'verdict', 'severity', 'reason', 'expected'],
          properties: {
            id: { type: 'string' },
            verdict: { type: 'string', enum: VERDICTS },
            severity: { type: 'integer' },
            reason: { type: 'string' },
            expected: { type: 'string' },
          },
        },
      },
    },
  },
}

export class VerifyError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const clipTo = (limit) => (s) => {
  const t = typeof s === 'string' ? s.trim() : ''
  return t.length > limit ? `${t.slice(0, limit)}…` : t
}
const clip = clipTo(MAX_SIDE_CHARS)
const clipContext = clipTo(MAX_CONTEXT_CHARS)

// Reasoning models (GPT-5 family, o-series) spend hidden, billed reasoning
// tokens; this check is a close read of a few passages, so a low-but-nonzero
// effort is a good trade for a quality model.
const REASONING_MODEL = /^(gpt-5|o\d)/
export const DEFAULT_VERIFY_REASONING = 'low'

// Verify a batch of flagged pairs in one request. Returns { [key]: result } for
// the pairs the model answered; pairs it skipped are simply absent (retry later).
export async function verifyBatch(pairs, { apiKey, model, reasoning, fetchImpl = fetch }) {
  if (!apiKey) {
    throw new VerifyError(
      500,
      'No OpenAI API key. Add OPENAI_API_KEY=… to .env.local in the project folder and restart npm run dev.',
    )
  }
  if (!Array.isArray(pairs) || pairs.length === 0) throw new VerifyError(400, 'No pairs to verify.')
  if (pairs.length > MAX_PAIRS) throw new VerifyError(400, `At most ${MAX_PAIRS} pairs per request.`)

  // Short ids keep the prompt small; map them back to the page's keys.
  const byId = new Map()
  const blocks = pairs.map((p, i) => {
    const id = `p${i + 1}`
    byId.set(id, p.key)
    const flag = p.flag ? `\nflag: ${p.flag}` : ''
    const ctx = (label, text) => {
      const c = clipContext(text)
      return c ? `\n${label}: ${c}` : ''
    }
    return (
      `[${id}]${flag}` +
      ctx('CONTEXT BEFORE A', p.before_a) +
      `\nPASSAGE A: ${clip(p.original)}` +
      ctx('CONTEXT AFTER A', p.after_a) +
      ctx('CONTEXT BEFORE B', p.before_b) +
      `\nPASSAGE B: ${clip(p.translation)}` +
      ctx('CONTEXT AFTER B', p.after_b)
    )
  })

  const useModel = model || DEFAULT_VERIFY_MODEL
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
      ...(REASONING_MODEL.test(useModel) ? { reasoning_effort: reasoning || DEFAULT_VERIFY_REASONING } : {}),
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
    throw new VerifyError(502, `OpenAI request failed: ${detail}`)
  }
  const message = data && data.choices && data.choices[0] && data.choices[0].message
  let parsed
  try {
    parsed = JSON.parse(message.content)
  } catch {
    throw new VerifyError(502, 'OpenAI returned an unreadable answer.')
  }

  const out = {}
  for (const r of Array.isArray(parsed.results) ? parsed.results : []) {
    const key = byId.get(r.id)
    if (!key) continue
    const verdict = VERDICTS.includes(r.verdict) ? r.verdict : 'fine'
    out[key] = {
      verdict,
      severity: verdict === 'fine' ? 0 : Math.min(5, Math.max(1, Math.round(Number(r.severity) || 1))),
      reason: verdict === 'fine' ? '' : String(r.reason || '').slice(0, 200),
      expected: verdict === 'fine' ? '' : String(r.expected || '').slice(0, 500),
    }
  }
  return { results: out, usage: data.usage || null }
}

// ---------------------------------------------------------------------------
// HTTP (cache on disk via the shared scan store, under a verify-<model> label)
// ---------------------------------------------------------------------------

export function verifyMiddleware(getConfig, store) {
  return async (req, res, next) => {
    const send = (status, body) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }
    try {
      const config = getConfig()
      const model = config.model || DEFAULT_VERIFY_MODEL
      const label = `verify-${model}` // keep these verdicts in their own file
      if (req.method === 'GET') {
        const book = new URL(req.url, 'http://x').searchParams.get('book')
        if (!book) throw new VerifyError(400, 'Missing ?book=')
        const data = await store.load(book, label)
        return send(200, { model, results: data.results })
      }
      if (req.method !== 'POST') return next()

      let body
      try {
        body = JSON.parse(await readBody(req, 512 * 1024))
      } catch (err) {
        throw err instanceof VerifyError ? err : new VerifyError(400, 'Request body must be JSON.')
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
      send(200, { model, results, usage })
    } catch (err) {
      send(err instanceof VerifyError ? err.status : 500, { error: err.message || String(err) })
    }
  }
}

// Convenience for vite.config.js: a store over scans/ shared with the scan
// endpoint (the verify-<model> label keeps the two sets of files apart).
export { createScanStore }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new VerifyError(413, 'Request too large.'))
        req.destroy()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

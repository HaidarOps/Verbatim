// Tests for the translation-rating endpoint, with OpenAI replaced by a fake.
// Run: node server/rateTranslation.test.mjs
import http from 'node:http'
import { rateTranslation, rateTranslationMiddleware } from './rateTranslation.js'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// A fake fetch that records the request and answers like the Chat Completions API.
function fakeOpenAI(reply, status = 200) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return { ok: status < 400, status, json: async () => reply }
  }
  return { fetchImpl, calls }
}
const chat = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] })

console.log('\n# rateTranslation')
{
  const { fetchImpl, calls } = fakeOpenAI(
    chat({
      score: 7,
      source_language: 'French',
      target_language: 'English',
      summary: 'Faithful but loose.',
      issues: [{ source_words: 'beau château', target_words: 'castle', problem: '"beau" (fine) dropped.' }],
    }),
  )
  const r = await rateTranslation(
    { original: 'Il y avait un beau château.', translation: 'There was a castle.' },
    { apiKey: 'test-key', model: 'some-model', fetchImpl },
  )
  check('returns score, summary and issues', r.score === 7 && r.summary === 'Faithful but loose.' && r.issues[0].sourceWords === 'beau château', JSON.stringify(r))
  const sent = calls[0]
  check('sends the key only in the Authorization header', sent.init.headers.Authorization === 'Bearer test-key' && !sent.init.body.includes('test-key'))
  check('sends both passages and asks for structured JSON', sent.body.messages[1].content.includes('Il y avait un beau château.') && sent.body.messages[1].content.includes('There was a castle.') && sent.body.response_format.type === 'json_schema')
  check('uses the configured model', sent.body.model === 'some-model')
}
{
  const { fetchImpl } = fakeOpenAI(chat({ score: 42, source_language: '', target_language: '', summary: '', issues: [] }))
  const r = await rateTranslation({ original: 'a', translation: 'b' }, { apiKey: 'k', fetchImpl })
  check('score is clamped to 1-10', r.score === 10)
}
async function rejects(fn, status, text) {
  try {
    await fn()
    return false
  } catch (e) {
    return e.status === status && e.message.includes(text)
  }
}
{
  const { fetchImpl, calls } = fakeOpenAI(chat({}))
  check('missing key explains how to set it', await rejects(() => rateTranslation({ original: 'a', translation: 'b' }, { apiKey: '', fetchImpl }), 500, '.env.local'))
  check('empty passage is rejected', await rejects(() => rateTranslation({ original: ' ', translation: 'b' }, { apiKey: 'k', fetchImpl }), 400, 'required'))
  check('overlong passage is rejected', await rejects(() => rateTranslation({ original: 'x'.repeat(5000), translation: 'b' }, { apiKey: 'k', fetchImpl }), 400, 'too long'))
  check('nothing was sent to OpenAI for invalid requests', calls.length === 0)
}
{
  const { fetchImpl } = fakeOpenAI({ error: { message: 'Incorrect API key provided' } }, 401)
  check('OpenAI errors are passed on readably', await rejects(() => rateTranslation({ original: 'a', translation: 'b' }, { apiKey: 'bad', fetchImpl }), 502, 'Incorrect API key'))
}

console.log('\n# HTTP endpoint')
{
  const server = http.createServer((req, res) =>
    rateTranslationMiddleware(() => ({ apiKey: '' }))(req, res, () => {
      res.statusCode = 404
      res.end()
    }),
  )
  await new Promise((r) => server.listen(0, r))
  const url = `http://127.0.0.1:${server.address().port}/`
  const post = await fetch(url, { method: 'POST', body: JSON.stringify({ original: 'a', translation: 'b' }) })
  const body = await post.json()
  check('POST without a key returns a JSON error', post.status === 500 && body.error.includes('OPENAI_API_KEY'), JSON.stringify(body))
  const bad = await fetch(url, { method: 'POST', body: 'not json' })
  check('malformed body returns 400', bad.status === 400)
  const get = await fetch(url)
  check('GET is not handled', get.status === 404)
  server.close()
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

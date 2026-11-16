// Tests for the verify endpoint, with OpenAI replaced by a fake.
// Run: node server/verifyIssues.test.mjs
import http from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createScanStore, verifyBatch, verifyMiddleware } from './verifyIssues.js'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// Fake OpenAI: p1 is an alignment error, p2 a translation error, the rest fine;
// can drop ids to simulate a gap the model left.
function fakeOpenAI({ drop = [] } = {}) {
  const calls = []
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const ids = [...body.messages[1].content.matchAll(/^\[(p\d+)\]/gm)].map((m) => m[1])
    const verdictFor = (id) =>
      id === 'p1' ? 'alignment_error' : id === 'p2' ? 'translation_error' : 'fine'
    const results = ids
      .filter((id) => !drop.includes(id))
      .map((id) => ({
        id,
        verdict: verdictFor(id),
        severity: verdictFor(id) === 'fine' ? 0 : id === 'p1' ? 5 : 3,
        reason: verdictFor(id) === 'fine' ? '' : 'something is wrong',
      }))
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ results }) } }], usage: { prompt_tokens: 80, completion_tokens: 8 } }),
    }
  }
  return { fetchImpl, calls }
}

console.log('\n# verifyBatch')
{
  const { fetchImpl, calls } = fakeOpenAI({ drop: ['p3'] })
  const pairs = [
    { key: 'a', original: 'One.', translation: 'Elsewhere.', flag: 'unmatched' },
    { key: 'b', original: 'Beautiful castle.', translation: 'Château.', flag: 'mismatch' },
    { key: 'c', original: 'Three.', translation: 'Trois.', flag: 'loose' },
  ]
  const { results } = await verifyBatch(pairs, { apiKey: 'k', model: 'strong-model', fetchImpl })
  check('maps ids back to keys with verdicts', results.a.verdict === 'alignment_error' && results.b.verdict === 'translation_error')
  check('fine verdict clears severity and reason', results.a.severity === 5 && results.b.reason === 'something is wrong')
  check('pairs the model skipped are left out (retried later)', !('c' in results))
  check('the Gale–Church flag is sent as a hint', calls[0].messages[1].content.includes('flag: unmatched'))
  check('one request, strict JSON', calls.length === 1 && calls[0].model === 'strong-model' && calls[0].response_format.json_schema.strict === true)
  await verifyBatch(pairs, { apiKey: 'k', model: 'gpt-5-mini', fetchImpl })
  check('GPT-5 models get a low reasoning effort by default', calls[1].reasoning_effort === 'low', String(calls[1].reasoning_effort))

  // An unknown verdict from the model is coerced to "fine" rather than trusted.
  const weird = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ results: [{ id: 'p1', verdict: 'maybe', severity: 9, reason: 'x' }] }) } }] }) })
  const coerced = await verifyBatch([{ key: 'a', original: 'o', translation: 't' }], { apiKey: 'k', fetchImpl: weird })
  check('an unknown verdict is coerced to fine', coerced.results.a.verdict === 'fine' && coerced.results.a.severity === 0)

  let threw = ''
  try {
    await verifyBatch(pairs, { apiKey: '', fetchImpl })
  } catch (e) {
    threw = e.message
  }
  check('missing key explains how to set it', threw.includes('.env.local'))
}

console.log('\n# endpoint + cache')
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verify-test-'))
  const { fetchImpl, calls } = fakeOpenAI()
  const store = createScanStore(dir)
  const mw = verifyMiddleware(() => ({ apiKey: 'k', model: 'strong-model', fetchImpl }), store)
  const server = http.createServer((req, res) => mw(req, res, () => ((res.statusCode = 404), res.end())))
  await new Promise((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (pairs) => fetch(base, { method: 'POST', body: JSON.stringify({ book: 'candide', pairs }) }).then((r) => r.json())

  const first = await post([{ key: 'a', original: 'One.', translation: 'X.', flag: 'unmatched' }, { key: 'b', original: 'Two.', translation: 'Deux.', flag: 'mismatch' }])
  check('first batch is verified', first.results.a.verdict === 'alignment_error' && calls.length === 1 && first.model === 'strong-model')
  const again = await post([{ key: 'a', original: 'One.', translation: 'X.' }, { key: 'c', original: 'Three.', translation: 'Trois.', flag: 'loose' }])
  check('cached pairs are not sent to OpenAI again', calls.length === 2 && calls[1].messages[1].content.includes('Three.') && !calls[1].messages[1].content.includes('One.'))
  check('response includes cached and fresh results', again.results.a && again.results.c)

  const all = await fetch(`${base}/?book=candide`).then((r) => r.json())
  check('GET returns everything verified for the book', Object.keys(all.results).sort().join() === 'a,b,c')
  const files = await readdir(dir)
  check('verdicts persist under a verify-<model> file, apart from scan files', files.join() === 'candide.verify-strong-model.json', files.join())
  const saved = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'))
  check('saved file holds every verdict', Object.keys(saved.results).length === 3)

  const evil = await fetch(base, { method: 'POST', body: JSON.stringify({ book: '../../etc/passwd', pairs: [{ key: 'z', original: 'a', translation: 'b' }] }) })
  check('book names cannot escape the scans folder', evil.ok && (await readdir(dir)).every((f) => !f.includes('/') && !f.includes('..')), (await readdir(dir)).join())
  server.close()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

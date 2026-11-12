// Tests for the scan endpoint, with OpenAI replaced by a fake.
// Run: node server/scanTranslations.test.mjs
import http from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createScanStore, scanBatch, scanMiddleware } from './scanTranslations.js'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// Fake OpenAI: scores every pair in the prompt; can drop ids to simulate gaps.
function fakeOpenAI({ drop = [] } = {}) {
  const calls = []
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const ids = [...body.messages[1].content.matchAll(/^\[(p\d+)\]/gm)].map((m) => m[1])
    const results = ids
      .filter((id) => !drop.includes(id))
      .map((id) => ({ id, score: id === 'p2' ? 3 : 8, kind: id === 'p2' ? 'translation_issue' : 'good', issue: id === 'p2' ? 'drops "beau"' : '' }))
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ results }) } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }),
    }
  }
  return { fetchImpl, calls }
}

console.log('\n# scanBatch')
{
  const { fetchImpl, calls } = fakeOpenAI({ drop: ['p3'] })
  const pairs = [
    { key: 'a', original: 'One.', translation: 'Un.' },
    { key: 'b', original: 'Beautiful castle.', translation: 'Château.' },
    { key: 'c', original: 'Three.', translation: 'Trois.' },
  ]
  const { results } = await scanBatch(pairs, { apiKey: 'k', model: 'cheap-model', fetchImpl })
  check('maps short ids back to keys', results.a.score === 8 && results.b.score === 3 && results.b.issue === 'drops "beau"')
  check('pairs the model skipped are left out (retried later)', !('c' in results))
  check('one request per batch, cheap model, strict JSON', calls.length === 1 && calls[0].model === 'cheap-model' && calls[0].response_format.json_schema.strict === true)
  check('non-reasoning models are not sent a reasoning setting', calls[0].reasoning_effort === undefined)
  await scanBatch(pairs, { apiKey: 'k', model: 'gpt-5-nano', fetchImpl })
  await scanBatch(pairs, { apiKey: 'k', model: 'gpt-5-nano', reasoning: 'low', fetchImpl })
  check('GPT-5 models get minimal reasoning by default, overridable', calls[1].reasoning_effort === 'minimal' && calls[2].reasoning_effort === 'low', JSON.stringify(calls.slice(1, 3).map((c) => c.reasoning_effort)))
  calls.splice(1, 2)
  const long = await scanBatch([{ key: 'x', original: 'o'.repeat(5000), translation: 't' }], { apiKey: 'k', fetchImpl })
  check('very long passages are truncated', calls[1].messages[1].content.length < 2000 && long.results.x)
  let threw = ''
  try {
    await scanBatch(pairs, { apiKey: '', fetchImpl })
  } catch (e) {
    threw = e.message
  }
  check('missing key explains how to set it', threw.includes('.env.local'))
}

console.log('\n# endpoint + cache')
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scan-test-'))
  const { fetchImpl, calls } = fakeOpenAI()
  const store = createScanStore(dir)
  const mw = scanMiddleware(() => ({ apiKey: 'k', model: 'cheap-model', fetchImpl }), store)
  const server = http.createServer((req, res) => mw(req, res, () => ((res.statusCode = 404), res.end())))
  await new Promise((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (pairs) => fetch(base, { method: 'POST', body: JSON.stringify({ book: 'candide', pairs }) }).then((r) => r.json())

  const first = await post([{ key: 'a', original: 'One.', translation: 'Un.' }, { key: 'b', original: 'Two.', translation: 'Deux.' }])
  check('first batch is scanned', Object.keys(first.results).length === 2 && calls.length === 1 && first.model === 'cheap-model')
  const again = await post([{ key: 'a', original: 'One.', translation: 'Un.' }, { key: 'c', original: 'Three.', translation: 'Trois.' }])
  check('cached pairs are not sent to OpenAI again', calls.length === 2 && calls[1].messages[1].content.includes('Three.') && !calls[1].messages[1].content.includes('One.'))
  check('response includes cached and fresh results', again.results.a && again.results.c)
  const cachedOnly = await post([{ key: 'b', original: 'Two.', translation: 'Deux.' }])
  check('a fully cached batch makes no OpenAI call', calls.length === 2 && cachedOnly.results.b)

  const all = await fetch(`${base}/?book=candide`).then((r) => r.json())
  check('GET returns everything scanned for the book', Object.keys(all.results).sort().join() === 'a,b,c')
  const files = await readdir(dir)
  const saved = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'))
  check('results persist on disk per book and model', files.join() === 'candide.cheap-model.json' && Object.keys(saved.results).length === 3, files.join())
  const reloaded = await createScanStore(dir).load('candide', 'cheap-model')
  check('a restarted server sees saved results', Object.keys(reloaded.results).length === 3)

  const evil = await fetch(base, { method: 'POST', body: JSON.stringify({ book: '../../etc/passwd', pairs: [{ key: 'z', original: 'a', translation: 'b' }] }) })
  check('book names cannot escape the scans folder', evil.ok && (await readdir(dir)).every((f) => !f.includes('/') && !f.includes('..')), (await readdir(dir)).join())
  server.close()
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

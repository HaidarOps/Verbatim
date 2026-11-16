// Tests for the confirmed-issues logic (src/issues.js).
// Run: node src/issues.test.mjs
import { countIssues, isConfirmedIssue, issueLevel, redSignals, runVerify } from './issues.js'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('\n# issueLevel / isConfirmedIssue')
{
  check('alignment error maps to alignment', issueLevel({ verdict: 'alignment_error' }) === 'alignment')
  check('translation error maps to translation', issueLevel({ verdict: 'translation_error' }) === 'translation')
  check('fine and missing map to null', issueLevel({ verdict: 'fine' }) === null && issueLevel(undefined) === null)
  check('isConfirmedIssue only for the two errors', isConfirmedIssue({ verdict: 'translation_error' }) && !isConfirmedIssue({ verdict: 'fine' }))
}

console.log('\n# redSignals')
{
  const beads = [
    { key: 'a', gcFlag: 'unmatched', original: 'x', translation: 'y' },
    { key: 'b', gcFlag: null, original: 'x', translation: 'y' }, // not flagged
    { key: 'c', gcFlag: 'mismatch', original: 'x', translation: '' }, // one-sided
    { key: 'd', gcFlag: 'loose', original: 'x', translation: 'y' },
  ]
  const signals = redSignals(beads)
  check('keeps only flagged, both-sided beads', signals.map((b) => b.key).join() === 'a,d', signals.map((b) => b.key).join())
}

console.log('\n# countIssues')
{
  const results = {
    a: { verdict: 'alignment_error' },
    b: { verdict: 'translation_error' },
    c: { verdict: 'translation_error' },
    d: { verdict: 'fine' },
  }
  const counts = countIssues(results)
  check('counts by kind and total', counts.alignment === 1 && counts.translation === 2 && counts.total === 3, JSON.stringify(counts))
  check('empty results give zeroes', countIssues({}).total === 0)
}

console.log('\n# runVerify posts flagged pairs to /api/verify')
{
  const items = redSignals([
    { key: 'k1', gcFlag: 'unmatched', original: 'One.', translation: 'Elsewhere.' },
    { key: 'k2', gcFlag: 'mismatch', original: 'Two.', translation: 'Deux.' },
  ])
  const sent = []
  let url = ''
  const fakeFetch = async (u, init) => {
    url = u
    const body = JSON.parse(init.body)
    sent.push(body)
    const results = Object.fromEntries(body.pairs.map((p) => [p.key, { verdict: 'fine', severity: 0, reason: '' }]))
    return { ok: true, json: async () => ({ results, usage: { prompt_tokens: 10, completion_tokens: 2 } }) }
  }
  const out = await runVerify(items, { book: 'b', fetchImpl: fakeFetch, onProgress: () => {} })
  check('targets the /api/verify endpoint', url === '/api/verify', url)
  check('each pair carries its Gale–Church flag as "flag"', sent[0].pairs[0].flag === 'unmatched' && sent[0].pairs[1].flag === 'mismatch')
  check('collects a result per pair', Object.keys(out.results).sort().join() === 'k1,k2')
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

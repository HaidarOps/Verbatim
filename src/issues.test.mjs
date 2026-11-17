// Tests for the confirmed-issues logic (src/issues.js).
// Run: node src/issues.test.mjs
import { candidates, countIssues, isConfirmedIssue, issueLevel, nominationFlag, redSignals, runVerify } from './issues.js'

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
  check(
    'misaligned is hidden by default, shown only when asked',
    issueLevel({ verdict: 'misaligned' }) === null &&
      issueLevel({ verdict: 'misaligned' }, { includeMisaligned: true }) === 'misaligned',
  )
  check('isConfirmedIssue excludes misaligned slips', isConfirmedIssue({ verdict: 'translation_error' }) && !isConfirmedIssue({ verdict: 'misaligned' }) && !isConfirmedIssue({ verdict: 'fine' }))
}

console.log('\n# candidates / redSignals (union of both indicators)')
{
  const beads = [
    { key: 'a', gcFlag: 'unmatched', original: 'x', translation: 'y' }, // length only
    { key: 'b', gcFlag: null, original: 'x', translation: 'y' }, // scan only (below)
    { key: 'c', gcFlag: 'mismatch', original: 'x', translation: '' }, // one-sided: dropped
    { key: 'd', gcFlag: 'loose', original: 'x', translation: 'y' }, // length + scan (below)
    { key: 'e', gcFlag: null, original: 'x', translation: 'y' }, // unflagged by both
  ]
  const scanResults = {
    b: { kind: 'not_matching', score: 1 }, // scan flag
    d: { kind: 'translation_issue', score: 3 }, // scan flag (also gc)
    e: { kind: 'good', score: 9 }, // not a scan flag
  }

  check('Gale–Church only (no scan) matches redSignals', redSignals(beads).map((b) => b.key).sort().join() === 'a,d')
  const union = candidates(beads, scanResults)
  check('union adds scan-only beads, still drops one-sided', union.map((b) => b.key).sort().join() === 'a,b,d', union.map((b) => b.key).join())
  check('both-flagged come first (highest confidence)', union[0].key === 'd', union.map((b) => b.key).join())
  check('empty scanResults equals Gale–Church only', candidates(beads, {}).map((b) => b.key).sort().join() === 'a,d')
}

console.log('\n# nominationFlag')
{
  const scanResults = { d: { kind: 'translation_issue', score: 3 } }
  check('names the length detector', nominationFlag({ key: 'a', gcFlag: 'mismatch' }, {}) === 'length check: length mismatch')
  check('names the scan detector', nominationFlag({ key: 'd', gcFlag: null }, scanResults) === 'quick AI read: likely a bad translation')
  check('names both when both fired', nominationFlag({ key: 'd', gcFlag: 'loose' }, scanResults) === 'length check: unusual length; quick AI read: likely a bad translation')
}

console.log('\n# countIssues')
{
  const results = {
    a: { verdict: 'alignment_error' },
    b: { verdict: 'translation_error' },
    c: { verdict: 'translation_error' },
    d: { verdict: 'fine' },
    e: { verdict: 'misaligned' },
  }
  const counts = countIssues(results)
  check('slips counted separately and left out of the reader total', counts.alignment === 1 && counts.translation === 2 && counts.misaligned === 1 && counts.total === 3, JSON.stringify(counts))
  check('empty results give zeroes', countIssues({}).total === 0)
}

console.log('\n# runVerify posts flagged pairs to /api/verify with a source hint')
{
  const scanResults = { k2: { kind: 'not_matching', score: 1 } }
  const items = candidates(
    [
      {
        key: 'k1',
        gcFlag: 'unmatched',
        original: 'One.',
        translation: 'Elsewhere.',
        context: { beforeSrc: 'Zero.', afterSrc: 'Two.', beforeTgt: 'Zéro.', afterTgt: 'Deux.' },
      },
      { key: 'k2', gcFlag: null, original: 'Two.', translation: 'Deux.' }, // scan-only, no context
    ],
    scanResults,
  )
  const sent = []
  let url = ''
  const fakeFetch = async (u, init) => {
    url = u
    const body = JSON.parse(init.body)
    sent.push(body)
    const results = Object.fromEntries(body.pairs.map((p) => [p.key, { verdict: 'fine', severity: 0, reason: '' }]))
    return { ok: true, json: async () => ({ results, usage: { prompt_tokens: 10, completion_tokens: 2 } }) }
  }
  const out = await runVerify(items, { book: 'b', scanResults, fetchImpl: fakeFetch, onProgress: () => {} })
  check('targets the /api/verify endpoint', url === '/api/verify', url)
  const flagFor = (key) => sent.flatMap((b) => b.pairs).find((p) => p.key === key).flag
  check('a length-flagged pair names the length check', flagFor('k1') === 'length check: no counterpart by length', flagFor('k1'))
  check('a scan-only pair names the AI read', flagFor('k2') === 'quick AI read: likely not a translation', flagFor('k2'))
  const pairFor = (key) => sent.flatMap((b) => b.pairs).find((p) => p.key === key)
  check('neighbour context is sent when present', pairFor('k1').before_a === 'Zero.' && pairFor('k1').after_a === 'Two.' && pairFor('k1').after_b === 'Deux.')
  check('context fields default to empty when absent', pairFor('k2').before_a === '' && pairFor('k2').after_b === '')
  check('collects a result per pair', Object.keys(out.results).sort().join() === 'k1,k2')
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

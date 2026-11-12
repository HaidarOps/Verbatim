// Tests for the whole-book scan logic. Run: node src/scan.test.mjs
import { compareScan, estimateTokens, makeBatches, runScan, scanLevel, scannable } from './scan.js'
import { pairKey } from './parallel.js'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('\n# levels and keys')
check('not_matching outranks the score', scanLevel({ score: 9, kind: 'not_matching' }) === 'not_matching')
check('score 1-3 is "bad", 4-5 "weak", 6+ unflagged', scanLevel({ score: 3, kind: 'translation_issue' }) === 'bad' && scanLevel({ score: 5, kind: 'translation_issue' }) === 'weak' && scanLevel({ score: 6, kind: 'translation_issue' }) === null)
check('pair keys are stable and text-sensitive', pairKey('a', 'b') === pairKey('a', 'b') && pairKey('a', 'b') !== pairKey('a', 'c') && pairKey('ab', '') !== pairKey('a', 'b'))

console.log('\n# batching')
{
  const items = Array.from({ length: 45 }, (_, i) => ({ key: `k${i}`, original: 'x'.repeat(100), translation: 'y'.repeat(100) }))
  const batches = makeBatches(items)
  check('at most 20 pairs per request', batches.length === 3 && batches.every((b) => b.length <= 20), batches.map((b) => b.length).join(','))
  const big = Array.from({ length: 6 }, (_, i) => ({ key: `b${i}`, original: 'x'.repeat(2500), translation: 'y'.repeat(2500) }))
  check('long pairs split by size', makeBatches(big).every((b) => b.length <= 2))
  check('every pair is in exactly one batch', makeBatches(items).flat().length === 45)
  const est = estimateTokens(items)
  check('token estimate is in the right range', est.batches === 3 && est.input > 3000 && est.input < 4500, JSON.stringify(est))
}

console.log('\n# comparison')
{
  // 10 pairs: GC flags 0-3; ChatGPT flags 2-5. Pair 9 is one-sided.
  const beads = Array.from({ length: 10 }, (_, i) => ({
    key: `k${i}`,
    original: `o${i}`,
    translation: i === 9 ? '' : `t${i}`,
    gcFlag: i === 9 ? 'unmatched' : i <= 1 ? 'mismatch' : i <= 3 ? 'loose' : null,
    gcP: i <= 3 ? 0.005 : 0.5,
  }))
  const r = (score, kind = score >= 7 ? 'good' : 'translation_issue') => ({ score, kind, issue: '' })
  const results = { k0: r(9), k1: r(8), k2: r(4), k3: r(1, 'not_matching'), k4: r(5), k5: r(3), k6: r(9), k7: r(8), k8: r(10) }
  const rep = compareScan(beads, results)
  check('one-sided pairs are excluded', rep.oneSided === 1 && rep.scannable === 9 && rep.scanned === 9)
  check('overlap counts', JSON.stringify(rep.overlap) === JSON.stringify({ both: 2, gcOnly: 2, scanOnly: 2, neither: 3 }), JSON.stringify(rep.overlap))
  check('conditional rates and lift', rep.gcAlsoScan === 0.5 && rep.scanAlsoGc === 0.5 && Math.abs(rep.lift - 0.5 / 0.4) < 1e-9, JSON.stringify([rep.gcAlsoScan, rep.scanAlsoGc, rep.lift]))
  const mismatch = rep.byGc.find((x) => x.level === 'mismatch')
  check('per-level table', mismatch.scanned === 2 && mismatch.flagged === 0 && mismatch.meanScore === 8.5, JSON.stringify(mismatch))
  check('not-matching counted', rep.notMatching === 1 && rep.byGc.find((x) => x.level === 'loose').notMatching === 1)
  check('examples sorted worst first', rep.examples.both[0].key === 'k3' && rep.examples.scanOnly[0].key === 'k5')
  const partial = compareScan(beads, { k0: r(2) })
  check('partial scans only count scanned pairs', partial.scanned === 1 && partial.byGc[2].pairs === 2 && partial.byGc[2].scanned === 1)
}

console.log('\n# running a scan (fake server)')
{
  const items = scannable(Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, original: `orig ${i}`, translation: `trans ${i}` })))
  const sent = []
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    sent.push(body)
    const results = Object.fromEntries(body.pairs.map((p) => [p.key, { score: 7, kind: 'good', issue: '' }]))
    return { ok: true, json: async () => ({ results, usage: { prompt_tokens: 100, completion_tokens: 10 } }) }
  }
  const progress = []
  const out = await runScan(items, { book: 'b', known: { k0: { score: 1 } }, fetchImpl: fakeFetch, onProgress: (p) => progress.push(p.done) })
  check('already-scanned pairs are not sent', sent.flatMap((b) => b.pairs).length === 49 && !sent.some((b) => b.pairs.some((p) => p.key === 'k0')))
  check('all results collected and usage summed', Object.keys(out.results).length === 49 && out.usage.prompt_tokens === 100 * out.total, JSON.stringify(out.usage))
  check('progress reported per batch', progress.at(-1) === out.total && out.failed === 0)

  let calls = 0
  const failing = async () => {
    calls++
    return { ok: false, status: 500, json: async () => ({ error: 'No OpenAI API key.' }) }
  }
  const bad = await runScan(items, { book: 'b', fetchImpl: failing, concurrency: 1 })
  check('stops after 3 failures in a row and reports why', bad.stopped && calls === 3 && bad.error === 'No OpenAI API key.', `${calls} calls`)
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

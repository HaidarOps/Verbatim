// Confirmed issues: the Gale–Church red signals that a strong ChatGPT model has
// read and agreed are genuinely bad (see server/verifyIssues.js). This is the
// end of the pipeline — the reader shows these with no live API call, because
// the verdicts are baked on disk. Two kinds:
//   alignment    the two passages aren't translations of each other
//   translation  they correspond, but the translation is seriously wrong
//
// Pure logic, no DOM: unit-tested in src/issues.test.mjs.

import { isScanFlag, runScan, scanLevel } from './scan.js'

// Overlay level for a verify result (see ISSUE_UNDERLINE in parallel.js), or
// null — for a missing result or the "fine" verdict (flag cleared).
//
// `misaligned` means our matcher slipped by a sentence or two: the counterpart
// is present, just next door (a tool glitch, not a fault in the book). Readers
// never see these — they only count/show as a level when `includeMisaligned`
// is set, which is the programmer-only "show slips" toggle.
export function issueLevel(result, { includeMisaligned = false } = {}) {
  if (!result) return null
  if (result.verdict === 'alignment_error') return 'alignment'
  if (result.verdict === 'translation_error') return 'translation'
  if (result.verdict === 'misaligned') return includeMisaligned ? 'misaligned' : null
  return null
}
// A reader-facing confirmed issue: alignment or translation, never a slip.
export const isConfirmedIssue = (result) => issueLevel(result) !== null

// The beads worth verifying: nominated by either cheap detector and with text
// on both sides, so there is something for the model to compare. Two
// indicators, each catching what the other can't:
//   Gale–Church (b.gcFlag)            — length anomalies; blind to meaning
//   the cheap whole-book scan          — meaning, but the weak model
// `scanResults` is keyed by bead.key (the cheap scan's results, see scan.js);
// pass {} (or omit) when no scan has been run — then this is Gale–Church only,
// exactly as before. The union is verified by the strong model, which filters
// the false positives, so a wide net here is safe. Highest-confidence first:
// passages both detectors flagged, then one.
export function candidates(beads, scanResults = {}) {
  const agree = (b) => (b.gcFlag ? 1 : 0) + (isScanFlag(scanResults[b.key]) ? 1 : 0)
  return beads
    .filter((b) => b.original && b.translation && agree(b) > 0)
    .sort((a, b) => agree(b) - agree(a))
}

// Gale–Church-only candidates (the fallback when there is no cheap scan).
export const redSignals = (beads) => candidates(beads)

// Plain-words hint for the verify prompt: which detector(s) nominated this
// passage and what each suspected, so the strong model knows what to look for.
const GC_WORDS = { unmatched: 'no counterpart by length', mismatch: 'length mismatch', loose: 'unusual length' }
const SCAN_WORDS = { not_matching: 'likely not a translation', bad: 'likely a bad translation', weak: 'possibly a weak translation' }
export function nominationFlag(bead, scanResults = {}) {
  const parts = []
  if (bead.gcFlag) parts.push(`length check: ${GC_WORDS[bead.gcFlag] || bead.gcFlag}`)
  const level = scanLevel(scanResults[bead.key])
  if (level) parts.push(`quick AI read: ${SCAN_WORDS[level] || level}`)
  return parts.join('; ')
}

// Tally of a results map: { alignment, translation, misaligned, total }.
// `total` is the reader-facing count (alignment + translation); `misaligned`
// (the aligner's own slips) is tracked separately and left out of the total.
export function countIssues(results) {
  let alignment = 0
  let translation = 0
  let misaligned = 0
  for (const key in results) {
    const verdict = results[key] && results[key].verdict
    if (verdict === 'alignment_error') alignment++
    else if (verdict === 'translation_error') translation++
    else if (verdict === 'misaligned') misaligned++
  }
  return { alignment, translation, misaligned, total: alignment + translation }
}

// Verify `items` (from candidates()) with the strong model, reusing runScan's
// batching, concurrency, resume and on-disk caching but against /api/verify.
// Each pair carries a `flag` hint naming which detector(s) nominated it (see
// nominationFlag); pass `scanResults` so the cheap scan's view is included in
// the hint. Same options and return shape as runScan.
export function runVerify(items, { scanResults = {}, ...options } = {}) {
  return runScan(items, {
    ...options,
    endpoint: '/api/verify',
    mapPair: (bead) => ({
      key: bead.key,
      original: bead.original,
      translation: bead.translation,
      flag: nominationFlag(bead, scanResults),
      // Neighbour sentences on each side (parallel.js attaches bead.context), so
      // the model can tell an off-by-one slip from a genuine divergence.
      before_a: bead.context ? bead.context.beforeSrc : '',
      after_a: bead.context ? bead.context.afterSrc : '',
      before_b: bead.context ? bead.context.beforeTgt : '',
      after_b: bead.context ? bead.context.afterTgt : '',
    }),
  })
}

// Confirmed issues: the Gale–Church red signals that a strong ChatGPT model has
// read and agreed are genuinely bad (see server/verifyIssues.js). This is the
// end of the pipeline — the reader shows these with no live API call, because
// the verdicts are baked on disk. Two kinds:
//   alignment    the two passages aren't translations of each other
//   translation  they correspond, but the translation is seriously wrong
//
// Pure logic, no DOM: unit-tested in src/issues.test.mjs.

import { runScan } from './scan.js'

// Overlay level for a verify result (see ISSUE_UNDERLINE in parallel.js), or
// null — for a missing result or the "fine" verdict (flag cleared).
export function issueLevel(result) {
  if (!result) return null
  if (result.verdict === 'alignment_error') return 'alignment'
  if (result.verdict === 'translation_error') return 'translation'
  return null
}
export const isConfirmedIssue = (result) => issueLevel(result) !== null

// The beads worth verifying: Gale–Church flagged (any red level) and with text
// on both sides, so there is something for the model to compare. A bead's
// `gcFlag`/`original`/`translation` come from linker.allBeads() (parallel.js).
export const redSignals = (beads) => beads.filter((b) => b.gcFlag && b.original && b.translation)

// Tally of confirmed issues in a results map: { alignment, translation, total }.
export function countIssues(results) {
  let alignment = 0
  let translation = 0
  for (const key in results) {
    const level = issueLevel(results[key])
    if (level === 'alignment') alignment++
    else if (level === 'translation') translation++
  }
  return { alignment, translation, total: alignment + translation }
}

// Verify `items` (from redSignals()) with the strong model, reusing runScan's
// batching, concurrency, resume and on-disk caching but against /api/verify,
// and sending each pair's Gale–Church flag as a hint. Same options and return
// shape as runScan.
export function runVerify(items, options = {}) {
  return runScan(items, {
    ...options,
    endpoint: '/api/verify',
    mapPair: ({ key, original, translation, gcFlag }) => ({ key, original, translation, flag: gcFlag }),
  })
}

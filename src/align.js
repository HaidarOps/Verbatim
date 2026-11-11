// Cross-language sentence alignment via the Gale–Church algorithm.
//
// Gale & Church (1993) observed that long source sentences translate to long
// target sentences, so a bilingual text can be aligned using only sentence
// *lengths* — no dictionary, no model, works for any language pair. A dynamic
// program finds the lowest-cost sequence of "beads" (1-1, 1-2, 2-1, 2-2) while
// allowing 1-0 / 0-1 beads so material present on only one side (title pages,
// translator's notes, image captions, Project Gutenberg license text) is
// skipped instead of derailing the rest of the alignment.
//
// This module is intentionally free of any DOM / browser dependency so it can
// be unit-tested directly in Node (see align.test.mjs).

// ---------------------------------------------------------------------------
// Text preprocessing
// ---------------------------------------------------------------------------

// Remove the Project Gutenberg header/footer so the license boilerplate (which
// differs wildly between editions and languages) does not pollute alignment.
// Non-Gutenberg text passes through untouched.
export function stripBoilerplate(text) {
  let t = text
  const start = t.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^*]*\*\*\*/i)
  if (start) {
    t = t.slice(start.index + start[0].length)
  }
  const end = t.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i)
  if (end) {
    t = t.slice(0, end.index)
  }
  return t
}

// Split text into sentences. Language-agnostic: break on paragraph boundaries
// and on sentence-terminating punctuation (Latin + CJK + Devanagari), keeping
// the terminator attached. Perfect segmentation is not required — Gale–Church
// tolerates the odd mis-split because it can pick 2-1 / 1-2 beads.
const TERMINATORS = '.!?…。！？؟।'
const SENTENCE_RE = new RegExp(
  `[^${TERMINATORS}]*[${TERMINATORS}]+[”"'’»)\\]]*|[^${TERMINATORS}]+$`,
  'gu',
)

export function splitSentences(text) {
  const sentences = []
  const paragraphs = text.replace(/\r/g, '').split(/\n+/)
  for (const para of paragraphs) {
    const trimmed = para.replace(/\s+/g, ' ').trim()
    if (!trimmed) continue
    const parts = trimmed.match(SENTENCE_RE) || [trimmed]
    for (const part of parts) {
      const s = part.trim()
      if (s) sentences.push(s)
    }
  }
  return sentences
}

// Unicode-aware length (code points), so a Cyrillic or CJK character counts as
// one unit just like a Latin one.
export function sentenceLength(s) {
  let n = 0
  for (const _ of s) n++
  return n
}

// ---------------------------------------------------------------------------
// Gale–Church core
// ---------------------------------------------------------------------------

// Normal CDF via a numerical erf approximation (Abramowitz & Stegun 7.1.26).
function erf(x) {
  const sign = x < 0 ? -1 : 1
  x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x)
  return sign * y
}

function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

const BIG = 1e6

// Cost of a length pairing, in the same -100·log(prob) units as the bead
// priors below. `c` is the expected target chars per source char (estimated
// from the two texts) and `s2` the per-character variance (Gale–Church use 6.8).
function lengthCost(l1, l2, c, s2) {
  if (l1 === 0 && l2 === 0) return 0
  const mean = (l1 + l2 / c) / 2
  if (mean <= 0) return BIG
  const z = Math.abs((c * l1 - l2) / Math.sqrt(s2 * mean))
  const pd = 2 * (1 - normCdf(z))
  if (pd <= 0) return BIG
  return -100 * Math.log(pd)
}

// Bead types with prior penalties (-100·log of their relative probability,
// the standard Gale–Church constants). [sourceCount, targetCount, penalty].
const BEADS = [
  [1, 1, 0],
  [1, 0, 450],
  [0, 1, 450],
  [2, 1, 230],
  [1, 2, 230],
  [2, 2, 440],
]

// Align two length arrays. Returns an ordered list of beads:
// { s: startSourceIndex, sn: sourceCount, t: startTargetIndex, tn: targetCount }.
export function alignLengths(sourceLens, targetLens, options = {}) {
  const n = sourceLens.length
  const m = targetLens.length
  const sumSrc = sourceLens.reduce((a, b) => a + b, 0)
  const sumTgt = targetLens.reduce((a, b) => a + b, 0)
  const c = options.c || (sumSrc > 0 ? Math.max(0.01, sumTgt / sumSrc) : 1)
  const s2 = options.s2 || 6.8

  // Prefix sums for O(1) multi-sentence bead lengths.
  const psSrc = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) psSrc[i + 1] = psSrc[i] + sourceLens[i]
  const psTgt = new Float64Array(m + 1)
  for (let j = 0; j < m; j++) psTgt[j + 1] = psTgt[j] + targetLens[j]

  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity))
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null))
  D[0][0] = 0

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const base = D[i][j]
      if (base === Infinity) continue
      for (const [sn, tn, penalty] of BEADS) {
        const ni = i + sn
        const nj = j + tn
        if (ni > n || nj > m) continue
        const l1 = psSrc[ni] - psSrc[i]
        const l2 = psTgt[nj] - psTgt[j]
        const cost = base + penalty + lengthCost(l1, l2, c, s2)
        if (cost < D[ni][nj]) {
          D[ni][nj] = cost
          back[ni][nj] = [i, j, sn, tn]
        }
      }
    }
  }

  const beads = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const step = back[i][j]
    if (!step) break
    const [pi, pj, sn, tn] = step
    beads.push({ s: pi, sn, t: pj, tn, cost: D[i][j] - D[pi][pj] })
    i = pi
    j = pj
  }
  beads.reverse()
  return { beads, c }
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

// Align two raw texts. `limit` caps how many leading sentences are considered
// (the UI only needs the opening segments, and a smaller window keeps the DP
// instant and avoids drift deep in long books). Returns the sentence arrays
// and the aligned beads mapped to their actual text.
export function alignTexts(sourceText, targetText, options = {}) {
  const limit = options.limit ?? Infinity
  const stripped = options.strip === false
    ? { s: sourceText, t: targetText }
    : { s: stripBoilerplate(sourceText), t: stripBoilerplate(targetText) }

  let srcSentences = splitSentences(stripped.s)
  let tgtSentences = splitSentences(stripped.t)
  if (limit !== Infinity) {
    srcSentences = srcSentences.slice(0, limit)
    tgtSentences = tgtSentences.slice(0, limit)
  }

  const srcLens = srcSentences.map(sentenceLength)
  const tgtLens = tgtSentences.map(sentenceLength)
  const { beads, c } = alignLengths(srcLens, tgtLens, options)

  const mapped = beads.map((b) => ({
    source: srcSentences.slice(b.s, b.s + b.sn),
    target: tgtSentences.slice(b.t, b.t + b.tn),
    sourceRange: [b.s, b.s + b.sn],
    targetRange: [b.t, b.t + b.tn],
    cost: b.cost,
  }))

  return { source: srcSentences, target: tgtSentences, beads: mapped, c }
}

// The first `count` beads that have text on *both* sides — i.e. real matched
// sentence pairs, skipping leading one-sided boilerplate/image beads. This is
// what the "where does the book start / here are the matches" button uses.
export function firstMatchedPairs(result, count = 3) {
  return result.beads
    .filter((b) => b.source.length > 0 && b.target.length > 0)
    .slice(0, count)
}

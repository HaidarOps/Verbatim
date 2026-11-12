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
    for (const { start, end } of sentenceSpans(trimmed)) {
      sentences.push(trimmed.slice(start, end))
    }
  }
  return sentences
}

// Sentence boundaries within one paragraph, as [{ start, end }] character
// offsets into `line`, so a sentence can be found again in the rendered page.
export function sentenceSpans(line) {
  const spans = []
  for (const m of line.matchAll(SENTENCE_RE)) {
    const raw = m[0]
    if (!raw) continue
    const lead = raw.length - raw.trimStart().length
    const start = m.index + lead
    const end = m.index + raw.trimEnd().length
    if (end <= start) continue
    const prev = spans[spans.length - 1]
    if (prev && isFalseBreak(line.slice(prev.start, prev.end), line.slice(start, end))) {
      prev.end = end
    } else {
      spans.push({ start, end })
    }
  }
  return spans
}

// A full stop that did not really end a sentence: the next piece starts with
// a lowercase letter, digit or comma ("No. 7", "esq., the…"), or the previous
// piece ends in a short capitalised abbreviation ("Mr.", "Dr.", "St.", "M.").
// Abbreviations are a capital plus at most one lowercase letter ("Mr.",
// "M."), or plus up to three lowercase consonants ("Mrs.", "Mgr.", "Bd."), so
// real words ("Row.", "Rome.") still end sentences.
const CONTINUATION_RE = /^[\p{Ll}\p{N},;:]/u
const ABBREVIATION_RE = /(?:^|[\s(“"'‘«])\p{Lu}(\p{Ll}?|[b-df-hj-np-tv-xz]{2,3})\.$/u
function isFalseBreak(prev, next) {
  return CONTINUATION_RE.test(next) || ABBREVIATION_RE.test(prev)
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
//
// `rel` adds a variance term proportional to the squared length (a relative
// error). It is 0 for sentences, as in the paper; whole sections need it
// because two translations of a 20,000-char chapter routinely differ by ~10%,
// which the per-character model alone would treat as impossibly unlikely.
function lengthCost(l1, l2, c, s2, rel = 0) {
  if (l1 === 0 && l2 === 0) return 0
  const mean = (l1 + l2 / c) / 2
  if (mean <= 0) return BIG
  const variance = s2 * mean + (rel * c * mean) ** 2
  const z = Math.abs((c * l1 - l2) / Math.sqrt(variance))
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
  const rel = options.rel || 0
  const beadTypes = options.beads || BEADS
  // In the paper a 1-0 / 0-1 bead also pays a length cost (as if matched to an
  // empty string). That is modest for a sentence but astronomically large for
  // a whole section, which would make skipping one effectively impossible.
  // `flatSkips` charges skip beads only their prior penalty.
  const flatSkips = !!options.flatSkips

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
      for (const [sn, tn, penalty] of beadTypes) {
        const ni = i + sn
        const nj = j + tn
        if (ni > n || nj > m) continue
        const l1 = psSrc[ni] - psSrc[i]
        const l2 = psTgt[nj] - psTgt[j]
        const skipBead = sn === 0 || tn === 0
        const cost =
          base + penalty + (flatSkips && skipBead ? 0 : lengthCost(l1, l2, c, s2, rel))
        if (cost < D[ni][nj]) {
          D[ni][nj] = cost
          back[ni][nj] = [i, j, sn, tn, penalty]
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
    const [pi, pj, sn, tn, penalty] = step
    const cost = D[i][j] - D[pi][pj]
    // lengthCost: the part of the cost due to the length mismatch alone
    // (-100·log p), without the prior penalty for the bead shape.
    beads.push({ s: pi, sn, t: pj, tn, cost, lengthCost: cost - penalty })
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

// ---------------------------------------------------------------------------
// Section level (the paper's first pass)
// ---------------------------------------------------------------------------
//
// Gale & Church align paragraphs first and then sentences *within* aligned
// paragraphs. A whole book is too big for a sentence-level DP, so we do the
// same at a coarser grain: split each book into sections at its heading
// elements, align the sections by length, then sentence-align inside a pair.
// Section boundaries come from document structure (heading tags) only — the
// heading *words* are never interpreted, so any language or numbering works.

// Section-level tuning (see alignSections). A one-sided section (an intro or
// endnotes only one edition has) is far more common than a one-sided sentence,
// so skipping one is cheaper than the paper's sentence-level 450.
const SECTION_REL = 0.1
const SECTION_SKIP_PENALTY = 200

// `blocks` is the book in reading order: [{ text, heading: boolean, kind?, ref? }],
// where `ref` is an opaque handle locating the block in the rendered book (it
// is carried through to each body line so alignments can be shown on screen)
// and `kind` identifies a heading's markup, e.g. "h2.chapter" (see selectBody).
// A section is a run of consecutive headings plus the body text after it, so
// stacked headings ("II" + "WHAT BECAME OF CANDIDE…", or "OEUVRES / DE /
// VOLTAIRE") collapse into one section title.
export function buildSections(blocks) {
  const sections = []
  let cur = null
  for (const { text, heading, kind, ref } of blocks) {
    if (!text) continue
    if (heading) {
      if (!cur || cur.lines.length > 0) {
        cur = { titles: [], kinds: [], lines: [] }
        sections.push(cur)
      }
      cur.titles.push(text)
      if (kind && !cur.kinds.includes(kind)) cur.kinds.push(kind)
    } else {
      if (!cur) {
        cur = { titles: [], kinds: [], lines: [] }
        sections.push(cur)
      }
      cur.lines.push({ text, ref })
    }
  }
  return sections.map((s) =>
    makeSection(
      // The last headings in a run belong to this section; earlier ones may be
      // a whole contents page marked up as headings.
      s.titles.slice(-2).join(' · ') || s.lines[0]?.text.slice(0, 60) || '',
      s.lines,
      s.kinds,
      s.titles,
    ),
  )
}

function makeSection(title, lines, kinds = [], titles = []) {
  const text = lines.map((l) => l.text).join('\n')
  return { title, titles, lines, kinds, text, length: sentenceLength(text) }
}

// ---------------------------------------------------------------------------
// The story itself: from the first chapter to the last
// ---------------------------------------------------------------------------
//
// Title pages, contents, introductions and prefaces before the first chapter,
// and indexes, notes, licence text or "FIN" after the last, have no
// counterpart (or the wrong one) in the other edition. selectBody() keeps only
// the chapters, found by structure rather than wording:
//
// 1. Numbering. Chapter headings carry a number sequence — I, II, III… or
//    1, 2, 3… — restarting at 1 for each part or book. The longest such run
//    marks the chapters. Stray numerals ("TOME XXXIII", the year MDCCCXXIX)
//    don't form a run and are ignored. Numerals are read in the first few
//    words of a heading only, and roman numerals must be valid.
// 2. Otherwise, heading markup: chapter headings are the most common kind of
//    heading (e.g. "h2.chapter") among sections with real text.
// Books with neither (fewer than `minChapters` chapters) are left unchanged.

const ROMAN = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/
const ROMAN_VALUE = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }

function numeralValue(token) {
  if (/^\d{1,3}$/.test(token)) return Number(token)
  if (!token || !ROMAN.test(token)) return null
  let total = 0
  for (let i = 0; i < token.length; i++) {
    const v = ROMAN_VALUE[token[i]]
    const next = ROMAN_VALUE[token[i + 1]] || 0
    total += v < next ? -v : v
  }
  return total
}

// The chapter number of a section: a numeral among the first two words of
// the last heading in its run that has one ("CHAPTER II.", "I. Fedor…").
// A letter followed by an apostrophe is an elided word, not a numeral
// (French "L'agent", "D'un").
export function sectionNumber(section) {
  const titles = section.titles || []
  for (let i = titles.length - 1; i >= 0; i--) {
    const words = [...titles[i].matchAll(/[\p{L}\p{N}]+/gu)].slice(0, 2)
    for (const m of words) {
      if (/['’]/.test(titles[i][m.index + m[0].length] || '')) continue
      const n = numeralValue(m[0])
      if (n) return n
    }
  }
  return null
}

// { first, last, count } section indexes of the longest 1, 2, 3… run, or
// null. A run may restart at 1 (a new part or book) and skip one missing
// number; numbers that fit nowhere ("TOME XXXIII", a year) are ignored.
function numberedRun(sections) {
  let best = null
  let run = null
  sections.forEach((s, i) => {
    const n = sectionNumber(s)
    if (n === null) return
    if (run && n > run.prev && n <= run.prev + 2) {
      run.prev = n
    } else if (run && n === 1 && run.count >= 2) {
      run.prev = 1
    } else if (n === 1) {
      run = { first: i, last: i, prev: 1, count: 0 }
    } else {
      return
    }
    run.last = i
    run.count++
    if (!best || run.count > best.count) best = { ...run }
  })
  return best
}

function headingKindRun(sections, minLength) {
  const counts = new Map()
  for (const s of sections) {
    if (s.length < minLength) continue
    for (const k of s.kinds || []) counts.set(k, (counts.get(k) || 0) + 1)
  }
  let chapterKind = null
  for (const [k, n] of counts) if (!chapterKind || n > counts.get(chapterKind)) chapterKind = k
  if (!chapterKind) return null
  const isChapter = (s) => (s.kinds || []).includes(chapterKind)
  const first = sections.findIndex(isChapter)
  let last = sections.length - 1
  while (last > first && !isChapter(sections[last])) last--
  return { first, last, count: counts.get(chapterKind) }
}

export function selectBody(sections, { minChapters = 3, minLength = 500 } = {}) {
  const numbered = numberedRun(sections)
  const run = numbered && numbered.count >= minChapters ? numbered : headingKindRun(sections, minLength)
  if (!run || run.count < minChapters) return sections
  return sections.slice(run.first, run.last + 1)
}

// Align two section lists. Returns matched pairs (both sides non-empty), each
// { title, targetTitle, sourceText, targetText, sourceLines, targetLines }, in
// reading order. Licence text and everything outside the chapters is left out
// first (see dropBoilerplateSections, selectBody; `strip: false` keeps it).
// Sections only one edition has fall out as 1-0 / 0-1 beads.
export function alignSections(srcSections, tgtSections, options = {}) {
  const prepare = (s) => (options.strip === false ? s : selectBody(dropBoilerplateSections(s)))
  const src = prepare(srcSections)
  const tgt = prepare(tgtSections)
  const srcLens = src.map((s) => s.length)
  const tgtLens = tgt.map((s) => s.length)
  const skip = options.skip ?? SECTION_SKIP_PENALTY
  const opts = {
    rel: options.rel ?? SECTION_REL,
    flatSkips: true,
    beads: BEADS.map(([sn, tn, p]) => [sn, tn, sn === 0 || tn === 0 ? skip : p]),
  }

  // The length ratio `c` from whole-book totals is skewed by material only one
  // edition has (a long introduction, endnotes). Re-estimate it from the
  // sections that actually paired up and align again.
  let { beads } = alignLengths(srcLens, tgtLens, opts)
  for (let pass = 0; pass < (options.passes ?? 2); pass++) {
    let a = 0
    let b = 0
    for (const bd of beads) {
      if (bd.sn === 0 || bd.tn === 0) continue
      for (let k = 0; k < bd.sn; k++) a += srcLens[bd.s + k]
      for (let k = 0; k < bd.tn; k++) b += tgtLens[bd.t + k]
    }
    if (a === 0 || b === 0) break
    beads = alignLengths(srcLens, tgtLens, { ...opts, c: b / a }).beads
  }

  return beads
    .filter((b) => b.sn > 0 && b.tn > 0)
    .map((b) => {
      const s = src.slice(b.s, b.s + b.sn)
      const t = tgt.slice(b.t, b.t + b.tn)
      return {
        title: s.map((x) => x.title).join(' · '),
        targetTitle: t.map((x) => x.title).join(' · '),
        sourceText: s.map((x) => x.text).join('\n'),
        targetText: t.map((x) => x.text).join('\n'),
        sourceLines: s.flatMap((x) => x.lines),
        targetLines: t.flatMap((x) => x.lines),
      }
    })
}

// Sentence-align one matched section pair in full, keeping where each
// sentence sits: { src, tgt, beads }, where src/tgt are
// [{ line, start, end }] (line index into the pair's lines, character offsets
// into that line) and beads are as returned by alignLengths.
export function alignLines(srcLines, tgtLines) {
  const locate = (lines) =>
    lines.flatMap((l, line) => sentenceSpans(l.text).map(({ start, end }) => ({ line, start, end })))
  const src = locate(srcLines)
  const tgt = locate(tgtLines)
  const len = (lines) => (s) => sentenceLength(lines[s.line].text.slice(s.start, s.end))
  const { beads } = alignLengths(src.map(len(srcLines)), tgt.map(len(tgtLines)))
  return { src, tgt, beads }
}

// Given sentence indices hit on one side ('src' or 'tgt'), return the full
// sets of sentence indices on both sides covered by the beads containing them.
export function counterpartSentences(alignment, side, hits) {
  const hitSet = new Set(hits)
  const own = new Set()
  const other = new Set()
  for (const b of alignment.beads) {
    const [ownStart, ownCount, otherStart, otherCount] =
      side === 'src' ? [b.s, b.sn, b.t, b.tn] : [b.t, b.tn, b.s, b.sn]
    let touched = false
    for (let k = ownStart; k < ownStart + ownCount; k++) if (hitSet.has(k)) touched = true
    if (!touched) continue
    for (let k = ownStart; k < ownStart + ownCount; k++) own.add(k)
    for (let k = otherStart; k < otherStart + otherCount; k++) other.add(k)
  }
  return { own: [...own].sort((a, b) => a - b), other: [...other].sort((a, b) => a - b) }
}

// Drop sections that belong to the Project Gutenberg header/footer, using the
// same markers as stripBoilerplate(). Books without the markers are untouched.
// The section holding a marker is trimmed rather than dropped, in case real
// text shares it. Trimming is by whole paragraph (the marker's paragraph goes
// too) so every remaining line still points at its paragraph on screen.
function dropBoilerplateSections(sections) {
  const startRe = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG/i
  const endRe = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i
  let out = sections
  const first = out.findIndex((s) => startRe.test(s.text))
  if (first !== -1) {
    const s = out[first]
    const at = s.lines.findIndex((l) => startRe.test(l.text))
    out = [makeSection(s.title, s.lines.slice(at + 1), s.kinds, s.titles), ...out.slice(first + 1)]
  }
  const last = out.findIndex((s) => endRe.test(s.text))
  if (last !== -1) {
    const s = out[last]
    const at = s.lines.findIndex((l) => endRe.test(l.text))
    out = [...out.slice(0, last), makeSection(s.title, s.lines.slice(0, at), s.kinds, s.titles)]
  }
  return out.filter((s) => s.length > 0)
}

// The first `count` beads that have text on *both* sides — i.e. real matched
// sentence pairs, skipping leading one-sided boilerplate/image beads. This is
// what the "where does the book start / here are the matches" button uses.
export function firstMatchedPairs(result, count = 3) {
  return result.beads
    .filter((b) => b.source.length > 0 && b.target.length > 0)
    .slice(0, count)
}

// ---------------------------------------------------------------------------
// How Gale–Church rates a bead (for the heat map)
// ---------------------------------------------------------------------------
//
// A bead's lengthCost is -100·log(p), p being how likely a length mismatch at
// least this large is between a sentence and its translation. Thresholds were
// calibrated on the bundled books: p < 1% flags ~2-4% of beads, p < 5% another
// ~3-4%, and one-sided beads ~0.5%. 2-1 / 1-2 shapes are not flagged on their
// own: translators split and merge sentences constantly (up to ~28% of beads).
export const FLAG_LEVELS = ['unmatched', 'mismatch', 'loose'] // most → least severe
const MISMATCH_COST = -100 * Math.log(0.01) // ≈ 460
const LOOSE_COST = -100 * Math.log(0.05) // ≈ 300

export function beadFlag(bead) {
  if (bead.sn === 0 || bead.tn === 0) return 'unmatched'
  if (bead.lengthCost > MISMATCH_COST) return 'mismatch'
  if (bead.lengthCost > LOOSE_COST) return 'loose'
  return null
}

// Probability behind a bead's length fit (1 = perfect fit), or null when one
// side is empty and there is no length comparison to make.
export function beadLengthP(bead) {
  if (bead.sn === 0 || bead.tn === 0) return null
  return Math.min(1, Math.exp(-bead.lengthCost / 100))
}

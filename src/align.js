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
// Greek's question mark is ";" (or U+037E, which looks the same); after a
// Greek word it ends a sentence, elsewhere ";" is just a semicolon.
const END = `(?:[${TERMINATORS}]|(?<=\\p{Script=Greek}[”"'’»)]*)[;\u037E])`
const SENTENCE_RE = new RegExp(`(?:(?!${END}).)*${END}+[”"'’»)\\]]*|(?:(?!${END}).)+$`, 'gsu')

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

const MAX_FULL_CELLS = 6e6
const BAND_MIN = 150
const BAND_SHARE = 0.15

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
  // Optional extra cost of matching source i… with target j… (sections only).
  const extraCost = options.extraCost || null

  // Prefix sums for O(1) multi-sentence bead lengths.
  const psSrc = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) psSrc[i + 1] = psSrc[i] + sourceLens[i]
  const psTgt = new Float64Array(m + 1)
  for (let j = 0; j < m; j++) psTgt[j + 1] = psTgt[j] + targetLens[j]

  // Flat typed arrays (cost, and which bead type reached each cell): a long
  // section pair has a thousand-plus sentences a side, i.e. millions of cells.
  // Past MAX_FULL_CELLS only a band around the diagonal is searched; a
  // translation never drifts far from it once front matter is gone.
  const W = m + 1
  const full = (n + 1) * W <= MAX_FULL_CELLS
  const halfBand = full ? Infinity : Math.max(BAND_MIN, Math.ceil(BAND_SHARE * Math.max(n, m)))
  const lo = (i) => (full ? 0 : Math.max(0, Math.floor((i * m) / Math.max(1, n) - halfBand)))
  const hi = (i) => (full ? m : Math.min(m, Math.ceil((i * m) / Math.max(1, n) + halfBand)))
  const D = new Float64Array((n + 1) * W).fill(Infinity)
  const back = new Int16Array((n + 1) * W).fill(-1)
  D[0] = 0

  for (let i = 0; i <= n; i++) {
    for (let j = lo(i), jEnd = hi(i); j <= jEnd; j++) {
      const base = D[i * W + j]
      if (base === Infinity) continue
      for (let b = 0; b < beadTypes.length; b++) {
        const [sn, tn, penalty] = beadTypes[b]
        const ni = i + sn
        const nj = j + tn
        if (ni > n || nj > m) continue
        const l1 = psSrc[ni] - psSrc[i]
        const l2 = psTgt[nj] - psTgt[j]
        const skipBead = sn === 0 || tn === 0
        let cost = base + penalty + (flatSkips && skipBead ? 0 : lengthCost(l1, l2, c, s2, rel))
        if (extraCost && !skipBead) cost += extraCost(i, j, sn, tn)
        if (cost < D[ni * W + nj]) {
          D[ni * W + nj] = cost
          back[ni * W + nj] = b
        }
      }
    }
  }

  const beads = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const b = back[i * W + j]
    if (b < 0) break
    const [sn, tn, penalty] = beadTypes[b]
    const pi = i - sn
    const pj = j - tn
    const cost = D[i * W + j] - D[pi * W + pj]
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
// One section against 3…12 of the other: an edition that splits a chapter (or
// a whole dialogue) into many headed parts the other doesn't have. Each extra
// section costs less than skipping it would, so lengths decide.
const MANY_TO_ONE = Array.from({ length: 10 }, (_, k) => k + 3).flatMap((k) => {
  const penalty = 230 + 60 * (k - 2)
  return [
    [1, k, penalty],
    [k, 1, penalty],
  ]
})
// Candidate length ratios (target / source characters) tried at the start. A
// translation is rarely under half or over twice the original's length, so
// the ratio stays in that range: otherwise ten books of one edition could be
// "explained" by the two books of a single-volume other edition.
const RATIO_MIN = 0.5
const RATIO_MAX = 2
const RATIO_GRID = Array.from({ length: 15 }, (_, k) => RATIO_MIN * 1.1 ** k) // 0.5 … 1.9

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
  const fresh = () => ({ titles: [], levels: [], kinds: [], lines: [] })
  for (const { text, heading, kind, ref } of blocks) {
    if (!text) continue
    if (heading) {
      if (!cur || cur.lines.length > 0) {
        cur = fresh()
        sections.push(cur)
      }
      cur.titles.push(text)
      cur.levels.push(headingLevel(kind))
      if (kind && !cur.kinds.includes(kind)) cur.kinds.push(kind)
    } else {
      if (!cur) {
        cur = fresh()
        sections.push(cur)
      }
      cur.lines.push({ text, ref })
    }
  }
  return sections.map((s) => makeSection(sectionTitle(s.titles, s.lines), s.lines, s.kinds, s.titles, s.levels))
}

// The last headings in a run belong to this section; earlier ones may be a
// whole contents page marked up as headings.
function sectionTitle(titles, lines) {
  return titles.slice(-2).join(' · ') || lines[0]?.text.slice(0, 60) || ''
}

// 1-6 for "h1"…"h6" (optionally with classes, "h2.chapter"); 7 when unknown,
// i.e. less prominent than any real heading.
function headingLevel(kind) {
  const m = /^h([1-6])\b/i.exec(kind || '')
  return m ? Number(m[1]) : 7
}

// `levels[i]` is the heading level of `titles[i]` (see headingLevel).
function makeSection(title, lines, kinds = [], titles = [], levels = titles.map(() => 7)) {
  const text = lines.map((l) => l.text).join('\n')
  return { title, titles, levels, lines, kinds, text, length: sentenceLength(text) }
}

// The most prominent heading level in a section's run (7 if it has none).
const topLevel = (s) => Math.min(7, ...(s.levels || []))

// Several consecutive sections as one (a chapter and its sub-sections).
function mergeSections(group) {
  if (group.length === 1) return group[0]
  return makeSection(
    group[0].title,
    group.flatMap((s) => s.lines),
    [...new Set(group.flatMap((s) => s.kinds || []))],
    group.flatMap((s) => s.titles || []),
    group.flatMap((s) => s.levels || (s.titles || []).map(() => 7)),
  )
}

// ---------------------------------------------------------------------------
// Introductions, prefaces, notes: what an editor added around the work
// ---------------------------------------------------------------------------
//
// A translator's introduction is often as long as a chapter and the other
// edition usually has a different one (or none), so a length-based aligner
// happily pairs the two introductions, or an introduction with chapter 1, and
// everything after it shifts. These parts are found by their heading — the
// one place a book names them — in the languages below, compared without case
// or accents. Only the heading as a whole counts ("INTRODUCTION.", "THE
// INTRODUCTION", "Translator's Preface", "ΕΙΣΑΓΩΓΗ"), never a word inside a
// chapter title ("Notes from Underground" stays).
//
// The part runs from its heading to the next heading at least as prominent
// (same or lower h-level) that isn't itself such a part, so an introduction
// with its own sub-headings ("I. Analysis", "***", "ARGUMENT") goes as a whole.

const FRONT_WORDS = [
  // English
  'introduction', 'introductory note', 'introductory essay', 'preface', 'prefatory note', 'foreword',
  "(translator|editor|author|publisher)s? (note|preface|introduction|foreword)", 'note on the (text|translation)',
  'contents', 'table of contents', 'acknowledg(e)?ments',
  // French
  'preface', 'avant-propos', 'avertissement', 'table des matieres', 'notice',
  // German
  'einleitung', 'vorwort', 'einfuhrung', 'vorbemerkung', 'inhalt', 'inhaltsverzeichnis',
  // Spanish, Italian, Portuguese
  'introduccion', 'prefacio', 'introduzione', 'prefazione', 'premessa', 'introducao',
  // Russian
  'введение', 'предисловие', 'вступление', 'вступительная статья', 'от переводчика', 'от издателя', 'содержание', 'оглавление',
  // Greek
  'εισαγωγη', 'προλογος', 'προλεγομενα', 'προοιμιο', 'περιεχομενα',
]
const BACK_WORDS = [
  'notes', 'endnotes', 'appendix', 'appendices', 'index', 'glossary', 'bibliography', 'afterword',
  'annexe', 'glossaire', 'bibliographie', 'postface', 'table',
  'anmerkungen', 'nachwort', 'anhang', 'register', 'glossar', 'literaturverzeichnis',
  'notas', 'apendice', 'indice', 'glosario', 'bibliografia', 'appendice', 'postfazione',
  'примечания', 'комментарии', 'послесловие', 'приложение', 'указатель',
  'σημειωσεις', 'σχολια', 'παραρτημα', 'επιμετρο', 'ευρετηριο',
]
// Front-matter headings may go on ("Introduction to the Symposium", "Préface
// du traducteur"); back-matter ones only take a label ("Appendix B", "Notes I").
const CONNECTOR = '(to|on|by|for|de|du|des|a|au|zu|zur|zum|von|del|della|di|к|ко|στην?|στο|του|της)'
const FRONT_RE = new RegExp(`^(the |a |la |le |l |die |der |das |el |il |η |ο |το )?(${FRONT_WORDS.join('|')})( ${CONNECTOR}( .*)?)?$`, 'u')
const BACK_RE = new RegExp(`^(the |les |die |la |le |le |gli |le |οι |τα )?(${BACK_WORDS.join('|')})( [a-z0-9]{1,4})?$`, 'u')

function plainHeading(s) {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .trim()
}

// Is this heading text the name of an introduction, preface, notes… ?
export function isMatterHeading(text) {
  if (!text || text.length > 80) return false
  const h = plainHeading(text)
  return FRONT_RE.test(h) || BACK_RE.test(h)
}

// Drop introductions, prefaces, contents, notes, appendices (see above). A
// part is kept if dropping it would remove more than half the book (then the
// heading is more likely the work's own title), and a section whose headings
// carry a chapter number is never dropped ("1. Introduction" in a treatise).
export function dropEditorialMatter(sections) {
  const total = sections.reduce((n, s) => n + s.length, 0)
  const drop = new Set()
  let i = 0
  while (i < sections.length) {
    const s = sections[i]
    const titles = s.titles || []
    const levels = s.levels || titles.map(() => 7)
    // The last matter heading in the run, if no ordinary heading at least as
    // prominent follows it there (the text below would then belong to that).
    // A chapter number above it ("CHAPTER 1 / Introduction") makes it a
    // chapter; numbered sub-headings below it ("I. Analysis") don't.
    let level = null
    let numbered = false
    titles.forEach((t, k) => {
      if (isMatterHeading(t)) {
        if (!numbered) level = levels[k]
      } else if (level !== null && levels[k] <= level) level = null
      if (level === null && sectionNumber({ titles: [t] }) !== null) numbered = true
    })
    if (level === null) {
      i++
      continue
    }
    let end = i + 1
    while (end < sections.length) {
      const next = sections[end]
      const ordinary = (next.titles || []).some((t, k) => (next.levels || [])[k] <= level && !isMatterHeading(t))
      if (ordinary) break
      end++
    }
    const size = sections.slice(i, end).reduce((n, x) => n + x.length, 0)
    if (size <= total / 2) for (let k = i; k < end; k++) drop.add(k)
    i = end
  }
  return drop.size ? sections.filter((_, k) => !drop.has(k)) : sections
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
  const at = numberedTitle(section)
  return at ? at.value : null
}

// { index, value }: which title in a section's run carries its chapter number.
// Greek numerals are letters marked with a keraia ("ΒΙΒΛΙΟΝ Β'." = 2).
function numberedTitle(section) {
  const titles = section.titles || []
  for (let i = titles.length - 1; i >= 0; i--) {
    const words = [...titles[i].matchAll(/[\p{L}\p{N}]+/gu)].slice(0, 2)
    for (const m of words) {
      const marked = /['’ʹ΄]/.test(titles[i][m.index + m[0].length] || '')
      const n = marked ? greekNumeralValue(m[0]) : numeralValue(m[0])
      if (n) return { index: i, value: n }
    }
  }
  return null
}

const GREEK_DIGITS = { Α: 1, Β: 2, Γ: 3, Δ: 4, Ε: 5, Ϛ: 6, Ζ: 7, Η: 8, Θ: 9, Ι: 10, Κ: 20, Λ: 30, Μ: 40, Ν: 50, Ξ: 60, Ο: 70, Π: 80, Ϟ: 90, Ρ: 100 }
function greekNumeralValue(token) {
  const t = token.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace('ΣΤ', 'Ϛ')
  if (!/^\p{Script=Greek}{1,4}$/u.test(t)) return null
  let total = 0
  for (const ch of t) {
    if (!GREEK_DIGITS[ch]) return null
    total += GREEK_DIGITS[ch]
  }
  return total
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
  return { first, last, count: counts.get(chapterKind), level: headingLevel(chapterKind) }
}

// The heading level of a numbered run's chapters: the level most of their
// numbered headings have (an edition may set "BOOK I" bigger than the rest).
function numberedLevel(sections, run) {
  const counts = new Map()
  for (let i = run.first; i <= run.last; i++) {
    const at = numberedTitle(sections[i])
    if (!at) continue
    const level = (sections[i].levels || [])[at.index] ?? 7
    counts.set(level, (counts.get(level) || 0) + 1)
  }
  let best = 7
  for (const [level, n] of counts) if (!counts.has(best) || n > counts.get(best)) best = level
  return best
}

// The chapters, first to last. A run of fewer than `minChapters` numbered
// chapters isn't trusted; chapter-shaped headings need only two. Sections
// below chapter level after the last chapter (its sub-sections) are kept,
// and every chapter's sub-sections are merged into it, so each edition's
// chapters line up whatever finer divisions one of them adds ("***", the
// speakers of a dialogue).
export function selectBody(sections, { minChapters = 3, minLength = 500 } = {}) {
  const numbered = numberedRun(sections)
  let run = null
  if (numbered && numbered.count >= minChapters) run = { ...numbered, level: numberedLevel(sections, numbered) }
  else {
    const byKind = headingKindRun(sections, minLength)
    if (byKind && byKind.count >= Math.min(2, minChapters)) run = byKind
  }
  if (!run) return sections
  let last = run.last
  while (last + 1 < sections.length && topLevel(sections[last + 1]) > run.level) last++
  return mergeSubsections(sections.slice(run.first, last + 1), run.level)
}

// A section starts a new chapter if its heading is at chapter level or above,
// or carries a chapter number (an edition may mark up one chapter heading
// differently from the rest).
function mergeSubsections(sections, level) {
  const out = []
  let group = []
  for (const s of sections) {
    if (group.length && (topLevel(s) <= level || sectionNumber(s) !== null)) {
      out.push(mergeSections(group))
      group = []
    }
    group.push(s)
  }
  if (group.length) out.push(mergeSections(group))
  return out
}

// When both editions number their chapters the same way (one's numbers are,
// nearly all, among the other's: I…X against Α'…Β', a single volume of a
// longer work), lengths alone can't tell which two of ten similar books match.
// Then pairing chapters with different numbers costs extra. Editions that
// number differently (one restarts each part, the other runs on) are left to
// lengths alone.
const NUMBER_MISMATCH = 300
function numberingCost(src, tgt) {
  const a = src.map(sectionNumber)
  const b = tgt.map(sectionNumber)
  const known = (xs) => xs.filter((x) => x !== null)
  // Numbered sections must hold most of the text (a short untitled cast list
  // or epigraph doesn't count against it).
  const covered = (secs, nums) => {
    const all = secs.reduce((n, s) => n + s.length, 0)
    return secs.reduce((n, s, i) => n + (nums[i] !== null ? s.length : 0), 0) >= all * 0.8
  }
  if (!covered(src, a) || !covered(tgt, b)) return null
  const [small, large] = known(a).length <= known(b).length ? [known(a), known(b)] : [known(b), known(a)]
  const pool = new Map()
  for (const x of large) pool.set(x, (pool.get(x) || 0) + 1)
  let found = 0
  for (const x of small) {
    if (pool.get(x) > 0) {
      pool.set(x, pool.get(x) - 1)
      found++
    }
  }
  if (small.length === 0 || found < small.length * 0.9) return null
  return (i, j) => (a[i] !== null && b[j] !== null && a[i] !== b[j] ? NUMBER_MISMATCH : 0)
}

// Align two section lists. Returns matched pairs (both sides non-empty), each
// { title, targetTitle, sourceText, targetText, sourceLines, targetLines }, in
// reading order. Licence text and everything outside the chapters is left out
// first (see dropBoilerplateSections, selectBody; `strip: false` keeps it).
// Sections only one edition has fall out as 1-0 / 0-1 beads.
export function alignSections(srcSections, tgtSections, options = {}) {
  const prepare = (s) =>
    options.strip === false ? s : selectBody(dropEditorialMatter(dropBoilerplateSections(s)))
  const src = prepare(srcSections)
  const tgt = prepare(tgtSections)
  const srcLens = src.map((s) => s.length)
  const tgtLens = tgt.map((s) => s.length)
  const skip = options.skip ?? SECTION_SKIP_PENALTY
  const opts = {
    rel: options.rel ?? SECTION_REL,
    flatSkips: true,
    extraCost: numberingCost(src, tgt),
    beads: [...BEADS.map(([sn, tn, p]) => [sn, tn, sn === 0 || tn === 0 ? skip : p]), ...MANY_TO_ONE],
  }

  // The length ratio `c` from whole-book totals is skewed by material only one
  // edition has (a long introduction, endnotes, or the other eight books when
  // one edition is a single volume). Start from whichever ratio explains the
  // sections best, then re-estimate it from the sections that paired up.
  const total = (beads) => beads.reduce((n, b) => n + b.cost, 0)
  let beads = null
  const sum = (xs) => xs.reduce((n, x) => n + x, 0)
  const bookRatio = sum(srcLens) > 0 ? sum(tgtLens) / sum(srcLens) : 1
  const start = bookRatio >= RATIO_MIN && bookRatio <= RATIO_MAX ? [bookRatio] : []
  for (const c of [...start, ...RATIO_GRID]) {
    const tried = alignLengths(srcLens, tgtLens, { ...opts, c }).beads
    if (!beads || total(tried) < total(beads)) beads = tried
  }
  for (let pass = 0; pass < (options.passes ?? 2); pass++) {
    let a = 0
    let b = 0
    for (const bd of beads) {
      if (bd.sn === 0 || bd.tn === 0) continue
      for (let k = 0; k < bd.sn; k++) a += srcLens[bd.s + k]
      for (let k = 0; k < bd.tn; k++) b += tgtLens[bd.t + k]
    }
    if (a === 0 || b === 0) break
    const c = Math.min(RATIO_MAX, Math.max(RATIO_MIN, b / a))
    beads = alignLengths(srcLens, tgtLens, { ...opts, c }).beads
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
export function dropBoilerplateSections(sections) {
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

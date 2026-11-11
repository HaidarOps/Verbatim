// Verification harness for the Gale–Church aligner. Run: node src/align.test.mjs
//
// We can't ship a real English↔Russian parallel epub into a unit test, so we
// verify the algorithm against *constructed* parallel data with a known gold
// alignment: identical text, a length-correlated synthetic "translation", and
// adversarial one-sided noise (front matter / image captions). Correctness is
// measured as precision/recall of recovered 1-1 pairs vs. the gold mapping.

import {
  splitSentences,
  alignLengths,
  alignTexts,
  firstMatchedPairs,
  buildSections,
  alignSections,
  sentenceSpans,
  alignLines,
  counterpartSentences,
} from './align.js'

let failures = 0
function check(name, cond, detail = '') {
  const ok = !!cond
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Deterministic RNG so the suite is stable across runs.
function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
function gaussian(rng) {
  const u = Math.max(1e-9, rng())
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// Build a sentence of roughly `len` characters, ending in a period.
function makeSentence(len, rng) {
  const target = Math.max(3, Math.round(len))
  let s = ''
  while (s.length < target - 1) {
    const w = 1 + Math.floor(rng() * 8)
    s += 'x'.repeat(w) + ' '
  }
  s = s.slice(0, target - 1).trimEnd()
  return s + '.'
}

function indexBySource(beads) {
  const map = new Map()
  for (const b of beads) map.set(b.s, b)
  return map
}

// ---------------------------------------------------------------------------
console.log('\n# splitSentences')
{
  const s = splitSentences('Hello world. How are you?\n\nNew paragraph! Yes.')
  check('splits into 4 sentences', s.length === 4, JSON.stringify(s))
  check('keeps terminators', s[0] === 'Hello world.' && s[1] === 'How are you?')
  const cjk = splitSentences('这是第一句。这是第二句！')
  check('splits CJK on 。！', cjk.length === 2, JSON.stringify(cjk))
  check('blank lines ignored', splitSentences('\n\n   \n').length === 0)
}

// ---------------------------------------------------------------------------
console.log('\n# identical text → clean diagonal')
{
  const sentences = []
  const rng = makeRng(1)
  for (let i = 0; i < 40; i++) sentences.push(makeSentence(20 + rng() * 80, rng))
  const text = sentences.join('\n')
  const res = alignTexts(text, text, { strip: false })
  const allDiagonal = res.beads.every(
    (b) => b.source.length === 1 && b.target.length === 1 && b.sourceRange[0] === b.targetRange[0],
  )
  check('every bead is 1-1 on the diagonal', allDiagonal && res.beads.length === 40, `${res.beads.length} beads`)
  const pairs = firstMatchedPairs(res, 3)
  check('first 3 matched pairs are identical text', pairs.every((p) => p.source[0] === p.target[0]))
}

// ---------------------------------------------------------------------------
// Core metric: recover a 1-1 gold mapping from a length-correlated translation.
function syntheticParallel({ n, ratio, noise, seed }) {
  const rng = makeRng(seed)
  const srcLens = []
  const tgtLens = []
  for (let i = 0; i < n; i++) {
    const sl = 15 + Math.floor(rng() * 90)
    srcLens.push(sl)
    const tl = Math.max(3, Math.round(sl * ratio * (1 + gaussian(rng) * noise)))
    tgtLens.push(tl)
  }
  return { srcLens, tgtLens }
}

function recallOfIdentityMapping(beads, offsetTarget = 0) {
  // gold: source i ↔ target i+offsetTarget as 1-1
  let hits = 0
  let total = 0
  const bySrc = indexBySource(beads)
  for (const [s, b] of bySrc) {
    if (b.sn === 1 && b.tn === 1) {
      total++
      if (b.t === s + offsetTarget) hits++
    }
  }
  return { recall: hits / Math.max(1, total), oneToOne: total }
}

console.log('\n# length-correlated synthetic translation (no noise)')
{
  const { srcLens, tgtLens } = syntheticParallel({ n: 120, ratio: 1.25, noise: 0.08, seed: 7 })
  const { beads } = alignLengths(srcLens, tgtLens)
  // fraction of source positions that map 1-1 to the correct target position
  let correct = 0
  for (const b of beads) if (b.sn === 1 && b.tn === 1 && b.t === b.s) correct++
  const frac = correct / srcLens.length
  check('≥90% of sentences recovered as correct 1-1', frac >= 0.9, `frac=${frac.toFixed(3)}`)
}

console.log('\n# stronger length noise still mostly aligns')
{
  const { srcLens, tgtLens } = syntheticParallel({ n: 120, ratio: 0.8, noise: 0.18, seed: 11 })
  const { beads } = alignLengths(srcLens, tgtLens)
  let correct = 0
  for (const b of beads) if (b.sn === 1 && b.tn === 1 && b.t === b.s) correct++
  const frac = correct / srcLens.length
  check('≥75% recovered under heavy noise', frac >= 0.75, `frac=${frac.toFixed(3)}`)
}

// ---------------------------------------------------------------------------
console.log('\n# robustness: one-sided leading noise (front matter / images)')
{
  // Real parallel body, but the TARGET side has extra leading material the
  // source lacks (title page, translator's note, an image caption). Those must
  // be absorbed by 0-1 beads; the real pairs must still line up (shifted).
  const { srcLens, tgtLens } = syntheticParallel({ n: 100, ratio: 1.1, noise: 0.08, seed: 23 })
  const noiseLens = [60, 8, 45, 12] // 4 target-only sentences up front
  const tgtWithNoise = [...noiseLens, ...tgtLens]
  const { beads } = alignLengths(srcLens, tgtWithNoise)
  const { recall } = recallOfIdentityMapping(beads, noiseLens.length)
  check('≥85% of real pairs still aligned past the noise', recall >= 0.85, `recall=${recall.toFixed(3)}`)

  // The feature itself only needs the first few matches to be right.
  const firstThree = beads.filter((b) => b.sn === 1 && b.tn === 1).slice(0, 3)
  const firstThreeCorrect = firstThree.filter((b) => b.t === b.s + noiseLens.length).length
  check('first 3 matched pairs point past the noise block', firstThreeCorrect === 3, `${firstThreeCorrect}/3`)
}

// ---------------------------------------------------------------------------
console.log('\n# merge/split produces a 2-1 bead')
{
  // Build parallel length arrays, then merge target sentences 10 & 11 into one
  // (a translator combined two sentences) → expect a 2-1 bead there.
  const { srcLens, tgtLens } = syntheticParallel({ n: 40, ratio: 1.0, noise: 0.05, seed: 31 })
  const merged = [...tgtLens]
  const combined = merged[10] + merged[11]
  merged.splice(10, 2, combined)
  const { beads } = alignLengths(srcLens, merged)
  const has21 = beads.some((b) => b.sn === 2 && b.tn === 1 && b.s <= 11 && b.s + b.sn >= 11)
  check('a 2-1 bead appears around the merged sentences', has21, JSON.stringify(beads.find((b) => b.sn === 2 && b.tn === 1) || null))
}

// ---------------------------------------------------------------------------
console.log('\n# end-to-end alignTexts with realistic structure + limit window')
{
  // Both editions share a chapter heading (as real parallel books do); the
  // target edition additionally has a one-sided image caption. Expected:
  // heading ↔ heading (1-1), caption skipped (0-1), body lines aligned.
  const rng = makeRng(99)
  const src = []
  const tgt = []
  for (let i = 0; i < 30; i++) {
    const sl = 25 + Math.floor(rng() * 70)
    src.push(makeSentence(sl, rng))
    tgt.push(makeSentence(sl * 1.15, rng))
  }
  const srcText = ['CHAPTER ONE.', ...src].join('\n')
  const tgtText = ['CHAPTER ONE.', 'See the illustration on this page.', ...tgt].join('\n')
  const res = alignTexts(srcText, tgtText, { strip: false, limit: 40 })
  const pairs = firstMatchedPairs(res, 3)
  check('produces 3 matched pairs', pairs.length === 3)
  check('first matched pair is the shared heading', pairs[0].sourceRange[0] === 0 && pairs[0].targetRange[0] === 0, JSON.stringify([pairs[0].sourceRange, pairs[0].targetRange]))
  // The one-sided caption must not cause downstream drift: whether the aligner
  // skips it (0-1) or absorbs it (1-2), body sentences after it must stay on
  // the correct +1 offset (target has one extra line before the body).
  const b2 = res.beads.find((b) => b.sourceRange[0] === 2 && b.source.length === 1 && b.target.length === 1)
  const b3 = res.beads.find((b) => b.sourceRange[0] === 3 && b.source.length === 1 && b.target.length === 1)
  check('body stays aligned past the one-sided caption (no drift)', !!b2 && b2.targetRange[0] === 3 && !!b3 && b3.targetRange[0] === 4, JSON.stringify([b2 && b2.targetRange, b3 && b3.targetRange]))
}

// ---------------------------------------------------------------------------
console.log('\n# sentence splitter ignores full stops that do not end a sentence')
{
  const s = splitSentences('Mr. Fogg lived at No. 7, Saville Row. He was rich. Phileas Fogg, esq., the member.')
  check('"Mr." / "No. 7" / "esq.," do not split', s.length === 3, JSON.stringify(s))
}

// ---------------------------------------------------------------------------
console.log('\n# sections come from heading structure, not heading words')
{
  const blocks = [
    { text: 'OEUVRES', heading: true },
    { text: 'DE VOLTAIRE', heading: true },
    { text: 'Title page text.', heading: false },
    { text: 'II', heading: true },
    { text: 'WHAT BECAME OF CANDIDE', heading: true },
    { text: 'Body one.', heading: false },
    { text: 'Body two.', heading: false },
  ]
  const secs = buildSections(blocks)
  check('stacked headings collapse into one section each', secs.length === 2, JSON.stringify(secs.map((s) => s.title)))
  check('section text is the body only', secs[1].text === 'Body one.\nBody two.')
}

// ---------------------------------------------------------------------------
console.log('\n# section alignment survives one-sided front and back matter')
{
  // Chapters of a translation, ~15% longer, with chapter titles in unrelated
  // wording/numbering. The target adds an introduction with the same raw
  // length as source chapter 1 (the Karamazov trap: 7,365 vs 7,647 chars) and
  // a preface; the source adds endnotes nearly as long as its last chapter
  // (the Candide trap: 8,184 vs 8,992 chars). Every chapter must still pair
  // with its own counterpart.
  const rng = makeRng(7)
  const chapterLens = Array.from({ length: 20 }, () => 4000 + Math.floor(rng() * 16000))
  const sec = (title, len) => ({ title, text: 'x'.repeat(len), length: len })
  const src = [
    ...chapterLens.map((l, i) => sec(`src-${i}`, l)),
    sec('endnotes', Math.round(chapterLens[19] * 0.9)),
  ]
  const tgt = [
    sec('intro', chapterLens[0]),
    sec('preface', 3700),
    ...chapterLens.map((l, i) => sec(`tgt-${i}`, Math.round(l * (1.15 + (rng() - 0.5) * 0.1)))),
  ]
  const pairs = alignSections(src, tgt, { strip: false })
  const wrong = pairs.filter((p) => p.title.replace('src-', '') !== p.targetTitle.replace('tgt-', ''))
  check('every chapter pairs with its counterpart', wrong.length === 0 && pairs.length === 20, `${pairs.length} pairs, wrong: ${JSON.stringify(wrong.map((p) => [p.title, p.targetTitle]))}`)
}

// ---------------------------------------------------------------------------
console.log('\n# sentence positions and cross-side lookup (used for highlighting)')
{
  const line = 'Mr. Fogg lived at No. 7, Saville Row. He was rich.'
  const spans = sentenceSpans(line)
  check('spans point at the exact sentence text', spans.map((s) => line.slice(s.start, s.end)).join('|') === 'Mr. Fogg lived at No. 7, Saville Row.|He was rich.', JSON.stringify(spans))

  // Two paragraphs each side; the target merges source sentences 2+3 into one.
  const L = (text) => ({ text })
  const srcLines = [L('The first sentence here. A second one follows.'), L('Third is short. Fourth closes it.')]
  const tgtLines = [L('La première phrase ici. Une deuxième suit.'), L('La troisième est courte et la quatrième la clôt.')]
  const al = alignLines(srcLines, tgtLines)
  check('every sentence remembers its paragraph', al.src.map((s) => s.line).join() === '0,0,1,1' && al.tgt.map((s) => s.line).join() === '0,0,1', JSON.stringify([al.src, al.tgt]))
  const fromSrc = counterpartSentences(al, 'src', [2])
  check('selecting one half of a 2-1 bead returns the whole bead', fromSrc.own.join() === '2,3' && fromSrc.other.join() === '2', JSON.stringify(fromSrc))
  const fromTgt = counterpartSentences(al, 'tgt', [0])
  check('lookup works from the translation side too', fromTgt.own.join() === '0' && fromTgt.other.join() === '0', JSON.stringify(fromTgt))
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

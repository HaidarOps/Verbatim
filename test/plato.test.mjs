// Editorial matter regression test on two Plato pairs, each with a different
// introduction on each side (the case that broke the Symposium: the English
// and Greek introductions are of similar length, so the aligner paired them
// and everything after was shifted).
//
//   Symposium: modern Greek (Phexis, intro "ΕΙΣΑΓΩΓΗ" with sub-sections)
//              ↔ English (Jowett, "INTRODUCTION.")
//   Republic:  English (Jowett, "THE INTRODUCTION" + "ARGUMENT" + "CHARACTERS",
//              all ten books) ↔ Greek volume 1 ("ΠΡΟΛΟΓΟΣ", books Α'-Β' only)
//
// Run: npm run test:books

import { serveBooks } from './nodeBooks.mjs'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const { base, close } = await serveBooks()
const { readBook } = await import('../src/chapters.js')
const { alignSections, alignLines, sectionNumber } = await import('../src/align.js')
const load = (name) => readBook(`${base}/books/${encodeURIComponent(name)}`)

// Matched sentence pairs of a section pair: [[source, target], …] and the
// count of one-sided sentences.
function sentencePairs(p) {
  const al = alignLines(p.sourceLines, p.targetLines)
  const text = (side, lines, start, n) => al[side].slice(start, start + n).map((s) => lines[s.line].text.slice(s.start, s.end)).join(' ')
  const both = al.beads.filter((b) => b.sn && b.tn)
  return {
    pairs: both.map((b) => [text('src', p.sourceLines, b.s, b.sn), text('tgt', p.targetLines, b.t, b.tn)]),
    oneSided: al.beads.length - both.length,
    beads: al.beads.length,
  }
}
const allText = (pairs) => pairs.map((p) => `${p.sourceText}\n${p.targetText}`).join('\n')

console.log('\n# Symposium (Greek ↔ English)')
{
  const el = await load('plato_sym_geek.epub')
  const en = await load('plato_sym_en.epub')
  const pairs = alignSections(el.sections, en.sections)
  const text = allText(pairs)
  check('the Greek introduction is left out', !text.includes('Εις συμπόσιον δοθέν υπό του Αγάθωνος'))
  check('the English introduction is left out', !text.includes('Of all the works of Plato the Symposium is the most perfect'))
  check('Gutenberg header and licence are left out', !/Project Gutenberg/i.test(text) && el.excluded.licence > 0 && en.excluded.licence > 0)
  check("the Greek translator's numbered notes are left out", el.excluded.note >= 20, `${el.excluded.note} notes`)
  check('the dialogue pairs with the dialogue', pairs.length === 1 && pairs[0].targetTitle === 'SYMPOSIUM', pairs.map((p) => `${p.title} ↔ ${p.targetTitle}`).join(' | '))
  const s = sentencePairs(pairs[0])
  check('it opens with the cast list on both sides', /ΑΠΟΛΛΟΔΩΡΟΣ/.test(s.pairs[0][0]) && /^PERSONS OF THE DIALOGUE/.test(s.pairs[0][1]), JSON.stringify(s.pairs[0]).slice(0, 160))
  const opening = s.pairs.find((x) => x[1].includes('Concerning the things about which you ask'))
  check('Apollodorus\' first line pairs with its translation', !!opening && opening[0].includes('Νομίζω πως δεν είμαι αμελέτητος'), JSON.stringify(opening || null).slice(0, 160))
  check('under 2% of sentences left without a partner', s.oneSided / s.beads < 0.02, `${s.oneSided} of ${s.beads}`)
}

console.log('\n# Republic (English, ten books ↔ Greek volume 1, two books)')
{
  const en = await load('test_Republic_en_plato.epub')
  const el = await load('test_Πολιτεία, Τόμος.epub')
  const pairs = alignSections(en.sections, el.sections)
  const text = allText(pairs)
  check('the English introduction, argument and characters are left out', !text.includes('THE Republic of Plato is the longest of his works') && !text.includes('The argument of the Republic is the search after Justice') && !text.includes('The principal characters in the Republic are'))
  check('the Greek prologue is left out', !text.includes('Η θεμελιώδης βάσι'))
  const numbers = pairs.map((p) => `${sectionNumber({ titles: p.title.split(' · ') })}/${sectionNumber({ titles: p.targetTitle.split(' · ') })}`)
  check('Book I ↔ Βιβλίον Α\', Book II ↔ Βιβλίον Β\', nothing else', numbers.join() === '1/1,2/2', `${numbers.join()} (${pairs.map((p) => `${p.title} ↔ ${p.targetTitle}`).join(' | ')})`)
  const one = sentencePairs(pairs[0])
  check('Book I opens on its first line in both', one.pairs[0][0].startsWith('I WENT down yesterday to the Piraeus') && one.pairs[0][1].includes('Κατέβηκα χθες εις τον Πειραιά'), JSON.stringify(one.pairs[0]).slice(0, 160))
  check('Book I closes on its last line in both', one.pairs.at(-1)[0].startsWith('And the result of the whole discussion') && one.pairs.at(-1)[1].startsWith('Ώστε εις το τέλος'), JSON.stringify(one.pairs.at(-1)).slice(0, 160))
  const two = sentencePairs(pairs[1])
  check('Book II opens on its first line in both', two.pairs[0][0].startsWith('WITH these words') && two.pairs[0][1].startsWith('Και εγώ μεν λοιπόν'), JSON.stringify(two.pairs[0]).slice(0, 160))
  const oneSided = one.oneSided + two.oneSided
  const beads = one.beads + two.beads
  // The Greek volume ends with the publisher's catalogue and prices, which
  // has no counterpart: those last sentences stay one-sided.
  check('under 6% of sentences left without a partner', oneSided / beads < 0.06, `${oneSided} of ${beads}`)
}

await close()
console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

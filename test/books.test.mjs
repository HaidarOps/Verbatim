// Alignment regression test on a verified parallel pair: the test editions of
// Around the World in Eighty Days (French original, English translation).
// The two books were checked by hand to correspond chapter for chapter, and
// the first and last sentence pair of every chapter were reviewed.
//
// Run: npm run test:books
// Refresh the expected pairs after an intended change (then review the diff):
//   npm run test:books -- --update

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveBooks } from './nodeBooks.mjs'

const GOLD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'around-the-world.gold.json')
const UPDATE = process.argv.includes('--update')

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const { base, close } = await serveBooks()
const { readBook } = await import('../src/chapters.js')
const { alignSections, alignLines, selectBody, sectionNumber } = await import('../src/align.js')

const fr = await readBook(`${base}/books/around_the_world_fr_test.epub`)
const en = await readBook(`${base}/books/around_the_world_en_test.epub`)

console.log('\n# what is left out')
check('one footnote left out of each edition (no pictures or navigation text)', fr.excluded.note === 1 && en.excluded.note === 1 && fr.excluded.figure + en.excluded.figure + fr.excluded.navigation + en.excluded.navigation === 0, JSON.stringify([fr.excluded, en.excluded]))
const allText = (b) => b.sections.map((s) => s.text).join('\n')
check('the translator\'s footnote is gone from the English', !allText(en).includes('remarkable eccentricity on the part of the London'))
check('the French footnote is gone too', !allText(fr).includes('Le traitement des fonctionnaires civils'))

console.log('\n# chapters')
const bodyFr = selectBody(fr.sections)
const bodyEn = selectBody(en.sections)
const numbers = (body) => body.map(sectionNumber)
const oneTo37 = Array.from({ length: 37 }, (_, i) => i + 1).join()
check('French body is chapters I-XXXVII, nothing before or after', numbers(bodyFr).join() === oneTo37, numbers(bodyFr).join())
check('English body is chapters I-XXXVII, nothing before or after', numbers(bodyEn).join() === oneTo37, numbers(bodyEn).join())

const pairs = alignSections(fr.sections, en.sections)
const pairNumbers = pairs.map((p) => `${sectionNumber({ titles: p.title.split(' · ') })}/${sectionNumber({ titles: p.targetTitle.split(' · ') })}`)
check('37 chapter pairs, each chapter with its own counterpart', pairs.length === 37 && pairNumbers.every((x, i) => x === `${i + 1}/${i + 1}`), pairNumbers.filter((x, i) => x !== `${i + 1}/${i + 1}`).join(' '))

console.log('\n# sentences')
const snip = (s) => s.replace(/\s+/g, ' ').slice(0, 40)
const observed = pairs.map((p) => {
  const al = alignLines(p.sourceLines, p.targetLines)
  const text = (side, lines, start, n) => al[side].slice(start, start + n).map((s) => lines[s.line].text.slice(s.start, s.end)).join(' ')
  const both = al.beads.filter((b) => b.sn && b.tn)
  const pair = (b) => [snip(text('src', p.sourceLines, b.s, b.sn)), snip(text('tgt', p.targetLines, b.t, b.tn))]
  return { first: pair(both[0]), last: pair(both.at(-1)), beads: al.beads.length, oneSided: al.beads.length - both.length }
})
const beads = observed.reduce((n, o) => n + o.beads, 0)
const oneSided = observed.reduce((n, o) => n + o.oneSided, 0)
check('under 1% of sentences left without a partner', oneSided / beads < 0.01, `${oneSided} of ${beads}`)
check('chapter XXXIV ends on its last line, not the footnote', observed[33].last[0].startsWith('Il avait perdu') && observed[33].last[1].includes('He had lost the wager'), JSON.stringify(observed[33].last))

if (UPDATE) {
  await writeFile(GOLD, `${JSON.stringify({ book: 'around_the_world (fr -> en) test editions', chapters: observed.map(({ first, last }) => ({ first, last })) }, null, 1)}\n`)
  console.log(`  wrote ${path.relative(process.cwd(), GOLD)} — review it before committing`)
} else {
  const gold = JSON.parse(await readFile(GOLD, 'utf8')).chapters
  const diffs = []
  gold.forEach((g, i) => {
    for (const where of ['first', 'last']) {
      const o = observed[i] && observed[i][where]
      if (!o || o[0] !== g[where][0] || o[1] !== g[where][1]) diffs.push(`ch ${i + 1} ${where}: expected ${JSON.stringify(g[where])}, got ${JSON.stringify(o)}`)
    }
  })
  check('first and last sentence pair of every chapter match the reviewed pairs', diffs.length === 0, diffs.slice(0, 3).join('\n        '))
}

await close()
console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

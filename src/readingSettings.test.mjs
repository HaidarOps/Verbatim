// Unit tests for the reading settings (text size, font, spacing, margins,
// theme). Run: node src/readingSettings.test.mjs

import { DEFAULT_SETTINGS, normalizeSettings, readerCss, stepFontSize, FONT_SIZES } from './readingSettings.js'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('\n# saved settings')
check('nothing saved gives the defaults', JSON.stringify(normalizeSettings({})) === JSON.stringify(DEFAULT_SETTINGS))
const odd = normalizeSettings({ fontSize: 333, font: 'comic', lineSpacing: 'relaxed', theme: 'dark', extra: 1 })
check('damaged values fall back one by one, good ones are kept', odd.fontSize === 100 && odd.font === 'book' && odd.lineSpacing === 'relaxed' && odd.theme === 'dark' && !('extra' in odd), JSON.stringify(odd))

console.log('\n# text size steps')
check('A+ from 100% is 110%', stepFontSize(100, 1) === 110)
check('A− from 100% is 90%', stepFontSize(100, -1) === 90)
check('stops at the largest size', stepFontSize(FONT_SIZES.at(-1), 1) === FONT_SIZES.at(-1))
check('stops at the smallest size', stepFontSize(FONT_SIZES[0], -1) === FONT_SIZES[0])

console.log('\n# what goes into each chapter')
const plain = readerCss(DEFAULT_SETTINGS)
check('defaults leave the book\'s font, size, spacing and colours alone', !/font-size|font-family|line-height|background:/.test(plain), plain)
const all = readerCss({ fontSize: 135, font: 'serif', lineSpacing: 'relaxed', margins: 'wide', theme: 'dark' })
check('size, font, spacing and margins are applied', all.includes('font-size: 135%') && all.includes('Georgia') && all.includes('line-height: 1.9') && all.includes('padding-left: 56px'), all)
check('every rule beats the book\'s own (!important)', all.split('\n').every((r) => r.includes('!important') || r.startsWith('img')))
check('dark theme recolours the page and the selection highlights', all.includes('#1b1b1d') && all.includes('::highlight(xh-picked)') && all.includes('::highlight(xh-match)'))
check('sepia recolours the page but keeps the normal highlights', readerCss({ theme: 'sepia' }).includes('#f4ecd8') && !readerCss({ theme: 'sepia' }).includes('::highlight'))

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

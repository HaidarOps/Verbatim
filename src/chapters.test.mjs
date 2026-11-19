// Tests for sanitizeChapter (src/chapters.js): what makes it safe to render
// chapters in iframes that allow scripts (needed for Safari).
// Run: node src/chapters.test.mjs
import { JSDOM } from 'jsdom'

// chapters.js imports epubjs, which expects browser globals at load time.
const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const k of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Node', 'NodeFilter']) globalThis[k] = dom.window[k]
const { leafBlocks, sanitizeChapter } = await import('./chapters.js')

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><head>
<script>parent.stolen = 1</script></head><body>
<p onclick="parent.stolen = 2">First paragraph.</p>
<p><a href="javascript:parent.stolen=3">a link</a> and <a href="#n1">a note</a>.</p>
<noscript><p>Shown only without scripts.</p></noscript>
<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>
<img src="javascript:alert(1)" onerror="alert(1)" alt="" />
<p>Last paragraph.</p>
</body></html>`

// epubjs parses chapters as XML (like readBook's alignment copy).
const parse = () => new dom.window.DOMParser().parseFromString(XHTML, 'application/xhtml+xml')
const texts = (doc) => leafBlocks(doc).map((b) => b.text)

console.log('\n# sanitizeChapter')
{
  const doc = parse()
  const before = texts(doc)
  sanitizeChapter(doc)
  const html = new dom.window.XMLSerializer().serializeToString(doc)
  check('script elements are removed', doc.querySelectorAll('script').length === 0)
  check('on* handler attributes are removed', !/\son[a-z]+=/i.test(html), html.match(/\son[a-z]+="[^"]*"/i)?.[0])
  check('javascript: URLs are removed (href, src, xlink:href)', !/javascript:/i.test(html))
  check('ordinary links are kept', doc.querySelector('a[href="#n1"]') !== null)
  check('noscript is unwrapped, its paragraph kept', doc.querySelectorAll('noscript').length === 0 && texts(doc).includes('Shown only without scripts.'))
  check('the alignment copy keeps the same blocks', JSON.stringify(texts(doc)) === JSON.stringify(before), JSON.stringify(texts(doc)))

  // The screen copy: epubjs serialises the chapter and the iframe re-parses it
  // as HTML — now with scripting on. Its blocks must match the XML copy's
  // (leafBlocks numbering is what alignment and highlighting share).
  const screen = new JSDOM(html, { runScripts: 'dangerously' }).window.document
  check('the screen copy (HTML, scripting on) numbers blocks identically', JSON.stringify(texts(screen)) === JSON.stringify(before), JSON.stringify(texts(screen)))
}

console.log('\n# without it, scripting would shift the numbering')
{
  const raw = new dom.window.XMLSerializer().serializeToString(parse())
  const screen = new JSDOM(raw, { runScripts: 'dangerously' }).window.document
  check('noscript content becomes text, losing a block', texts(screen).length === texts(parse()).length - 1, JSON.stringify(texts(screen)))
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)

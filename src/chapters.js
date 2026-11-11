import ePub from 'epubjs'

// A table-of-contents entry is a "chapter" when its label begins with a roman
// numeral (optionally prefixed by "Chapter"), e.g. "Chapter III. …" or "III. …".
// Book/part headings and front matter ("Contents", "Vorwort", "PART I",
// "Erstes Buch", …) are excluded so the Nth chapter of one edition lines up
// with the Nth chapter of the other even when their front matter differs.
export function isChapterLabel(label) {
  const t = (label || '').trim()
  if (/^(book|part|buch|teil|volume)\b/i.test(t)) return false
  return /^(chapter\s+)?[ivxlcdm]+[.\s]/i.test(t)
}

// Open an epub and return its Book plus the ordered list of chapter entries.
export async function openAlignBook(url) {
  const book = ePub(url, { openAs: 'epub' })
  await book.ready
  await book.loaded.navigation

  const flat = []
  const walk = (items) => {
    for (const it of items || []) {
      flat.push(it)
      if (it.subitems && it.subitems.length) walk(it.subitems)
    }
  }
  walk(book.navigation && book.navigation.toc)

  const chapters = flat
    .map((it) => ({ label: (it.label || '').trim(), href: it.href || '' }))
    .filter((it) => it.href && isChapterLabel(it.label))

  return { book, chapters }
}

// Collect block-level text (one paragraph/heading per line, inner whitespace
// collapsed) between a chapter's anchor and the next chapter's anchor. Using
// block elements avoids the spurious mid-sentence newlines that Project
// Gutenberg's hard-wrapped source would otherwise introduce.
function blockTextInRange(root, startId, stopId) {
  const doc = root.ownerDocument || root
  const body = (root.querySelector && root.querySelector('body')) || root
  const blocks = body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, li')

  const startEl = startId && doc.getElementById ? doc.getElementById(startId) : null
  const stopEl = stopId && doc.getElementById ? doc.getElementById(stopId) : null

  let range = null
  try {
    range = doc.createRange()
    if (startEl) range.setStartBefore(startEl)
    else range.setStart(body, 0)
    if (stopEl) range.setEndBefore(stopEl)
    else range.setEnd(body, body.childNodes.length)
  } catch {
    range = null
  }

  const lines = []
  for (const el of blocks) {
    if (range && range.intersectsNode && !range.intersectsNode(el)) continue
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) lines.push(text)
  }

  if (lines.length === 0) {
    return (body.textContent || '').replace(/[ \t]+/g, ' ').trim()
  }
  return lines.join('\n')
}

// Extract the plain text of chapter `index` from an opened align-book.
export async function extractChapterText(book, chapters, index) {
  const ch = chapters[index]
  if (!ch) return ''
  const [file, anchor] = ch.href.split('#')

  const next = chapters[index + 1]
  const stopAnchor =
    next && next.href.split('#')[0] === file ? next.href.split('#')[1] : null

  let section = book.spine.get(file)
  if (!section) {
    section = book.spine.spineItems.find((it) => it.href && it.href.indexOf(file) !== -1)
  }
  if (!section) return ''

  const root = await section.load(book.load.bind(book))
  const text = blockTextInRange(root, anchor, stopAnchor)
  section.unload()
  return text
}

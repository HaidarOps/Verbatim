import ePub from 'epubjs'
import { buildSections } from './align.js'

// Block-level elements that carry the book's text. Only the innermost ones are
// read (a <blockquote> wrapping <p>s is read via its <p>s), so nothing is
// counted twice.
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li'
const HEADING_RE = /^h[1-6]$/i

// Read one spine item as [{ text, heading }] in document order. Whether a block
// is a heading comes from its tag, never from its wording, so this works for
// any language and any chapter-numbering scheme.
function readBlocks(root) {
  const body = (root.querySelector && root.querySelector('body')) || root
  const out = []
  for (const el of body.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.querySelector(BLOCK_SELECTOR)) continue
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) out.push({ text, heading: HEADING_RE.test(el.localName || el.tagName) })
  }
  return out
}

// Read an epub's text and split it into sections (see buildSections in
// align.js). The book is closed again before returning.
export async function loadSections(url) {
  const book = ePub(url, { openAs: 'epub' })
  try {
    await book.ready
    const blocks = []
    for (const item of book.spine.spineItems) {
      if (item.linear === false || item.linear === 'no') continue
      const root = await item.load(book.load.bind(book))
      blocks.push(...readBlocks(root))
      item.unload()
    }
    return buildSections(blocks)
  } finally {
    book.destroy()
  }
}

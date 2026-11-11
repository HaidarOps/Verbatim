import ePub from 'epubjs'
import { buildSections } from './align.js'

// Block-level elements that carry the book's text. Only the innermost ones are
// read (a <blockquote> wrapping <p>s is read via its <p>s), so nothing is
// counted twice.
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li'
const HEADING_RE = /^h[1-6]$/i

// Collapse whitespace the same way everywhere text is compared or located.
export function normalizeText(s) {
  return (s || '').replace(/\s+/g, ' ').trim()
}

// The text blocks of one chapter file, in document order: [{ el, text }].
// A block's position in this list is its identity: the same function runs on
// the copy read for alignment and on the copy rendered on screen, so the Nth
// block of one is the Nth block of the other.
export function leafBlocks(doc) {
  const body = (doc.querySelector && doc.querySelector('body')) || doc
  const out = []
  for (const el of body.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.querySelector(BLOCK_SELECTOR)) continue
    const text = normalizeText(el.textContent)
    if (text) out.push({ el, text })
  }
  return out
}

// Identifies a block across both copies: chapter file (spine index) + ordinal.
export function blockKey(spine, ord) {
  return `${spine}:${ord}`
}

// Read an epub's text and split it into sections (see buildSections in
// align.js). Each body line carries `ref: { spine, ord }` locating it on
// screen. Whether a block is a heading comes from its tag, never its wording.
// The book is closed again before returning.
export async function loadSections(url) {
  const book = ePub(url, { openAs: 'epub' })
  try {
    await book.ready
    const blocks = []
    for (const item of book.spine.spineItems) {
      if (item.linear === false || item.linear === 'no') continue
      const root = await item.load(book.load.bind(book))
      leafBlocks(root).forEach(({ el, text }, ord) => {
        blocks.push({
          text,
          heading: HEADING_RE.test(el.localName || el.tagName),
          ref: { spine: item.index, ord },
        })
      })
      item.unload()
    }
    return buildSections(blocks)
  } finally {
    book.destroy()
  }
}

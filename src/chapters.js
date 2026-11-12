import * as epubModule from 'epubjs'
import { buildSections } from './align.js'

// epubjs is CommonJS: bundlers hand back the function as the default export,
// Node wraps it once more. Accept both so this file also runs in Node tests.
const ePub = typeof epubModule.default === 'function' ? epubModule.default : epubModule.default.default

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
// block of one is the Nth block of the other. (Blocks left out of the
// alignment by excludedReason() keep their place in this list, so excluding
// more or less never shifts what the reader highlights.)
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

// ---------------------------------------------------------------------------
// What is not the story
// ---------------------------------------------------------------------------
//
// Footnotes, picture captions and navigation (contents, index) are left out
// of the alignment: an editor's note in one edition has no counterpart in the
// other and derails everything after it. Decided from markup, not wording, so
// it works in any language:
//   note        EPUB/ARIA note types, note-like class names, a block that
//               starts with a "[n]" marker or with a link back to one
//   figure      <figure>/<figcaption>, caption/illustration classes,
//               "[Illustration…]" placeholders
//   navigation  blocks that are mostly link text (a contents page, an index)

const NOTE_TYPE = /(^|\s)(doc-)?(foot|end|rear)?notes?(\s|$)/i
const NOTE_CLASS = /footnote|endnote|fnote|transnote|trnote|^notes?$/i
const FIGURE_CLASS = /^fig|caption|illus/i
const NOTE_MARKER = /^\s*\[\d+\]/
const ILLUSTRATION = /^\s*\[illus/i
const SHORT_MARK = /^\s*[[(]?(\d{1,3}|[*†‡§]+|[a-z])[\])]?\s*$/i

function classTokens(el) {
  const c = el.getAttribute && el.getAttribute('class')
  return c ? c.split(/\s+/).filter(Boolean) : []
}

// Why a block is left out of the alignment ('note' | 'figure' |
// 'navigation'), or null when it is story text.
export function excludedReason(el, text) {
  if (NOTE_MARKER.test(text)) return 'note'
  if (ILLUSTRATION.test(text)) return 'figure'

  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const tag = (node.localName || node.tagName || '').toLowerCase()
    if (tag === 'body' || tag === 'html') break
    if (tag === 'figure' || tag === 'figcaption') return 'figure'
    if (tag === 'aside') return 'note'
    const type = `${node.getAttribute('epub:type') || ''} ${node.getAttribute('role') || ''}`
    if (NOTE_TYPE.test(type)) return 'note'
    const classes = classTokens(node)
    if (classes.some((c) => NOTE_CLASS.test(c))) return 'note'
    if (classes.some((c) => FIGURE_CLASS.test(c))) return 'figure'
  }

  // A note that starts with a link back to its reference mark ("[1]", "*").
  const links = el.querySelectorAll('a[href]')
  const first = links[0]
  if (first && SHORT_MARK.test(first.textContent) && text.startsWith(normalizeText(first.textContent))) {
    if ((first.getAttribute('href') || '').includes('#')) return 'note'
  }

  // Mostly link text: a contents page or an index, not prose.
  let linked = 0
  for (const a of links) linked += normalizeText(a.textContent).length
  if (linked > 0 && linked >= text.length * 0.6) return 'navigation'
  return null
}

// A heading's kind: tag plus classes ("h2.chapter"). Chapter headings all
// share one kind, which is how selectBody() in align.js finds the chapters.
function headingKind(el) {
  return [(el.localName || el.tagName || '').toLowerCase(), ...classTokens(el).sort()].join('.')
}

// ---------------------------------------------------------------------------
// Reading a book
// ---------------------------------------------------------------------------

// Read an epub's text and split it into sections (see buildSections in
// align.js). Each body line carries `ref: { spine, ord }` locating it on
// screen. Whether a block is a heading comes from its tag, never its wording.
// Returns { sections, excluded: { note, figure, navigation } (counts) }.
// The book is closed again before returning.
export async function readBook(url) {
  const book = ePub(url, { openAs: 'epub' })
  try {
    await book.ready
    const blocks = []
    const excluded = { note: 0, figure: 0, navigation: 0 }
    for (const item of book.spine.spineItems) {
      if (item.linear === false || item.linear === 'no') continue
      const root = await item.load(book.load.bind(book))
      leafBlocks(root).forEach(({ el, text }, ord) => {
        const reason = excludedReason(el, text)
        if (reason) {
          excluded[reason]++
          return
        }
        const heading = HEADING_RE.test(el.localName || el.tagName)
        blocks.push({ text, heading, kind: heading ? headingKind(el) : undefined, ref: { spine: item.index, ord } })
      })
      item.unload()
    }
    return { sections: buildSections(blocks), excluded }
  } finally {
    book.destroy()
  }
}

export async function loadSections(url) {
  return (await readBook(url)).sections
}

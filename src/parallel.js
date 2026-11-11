// Cross-highlighting between the two panes of the compare reader.
//
// Select text in either book and the sentences it touches are highlighted in
// one colour, while the sentences they were aligned to (Gale–Church, see
// align.js) are highlighted in another colour in the other book, which
// scrolls to show them.
//
// A selection is located by (chapter file, block ordinal, character offsets
// into the block's whitespace-normalised text). leafBlocks() numbers blocks
// identically on the copy read for alignment and on the copy rendered on
// screen, so these positions mean the same thing on both. Highlights use the
// CSS Custom Highlight API, which paints ranges without touching the book's
// DOM; they are re-applied whenever epubjs (re)renders a chapter.

import { alignLines, counterpartSentences } from './align.js'
import { blockKey, leafBlocks } from './chapters.js'

const PICKED_COLOR = 'rgba(255, 190, 0, 0.45)' // what you selected
const MATCH_COLOR = 'rgba(70, 150, 255, 0.35)' // its counterpart
const OTHER = { src: 'tgt', tgt: 'src' }

// ---------------------------------------------------------------------------
// Alignment lookup
// ---------------------------------------------------------------------------

// `pairs` are matched section pairs from alignSections(). Sentence alignment
// of a pair is computed the first time something in it is selected.
export function createLinker(pairs) {
  const index = { src: new Map(), tgt: new Map() }
  pairs.forEach((p, pair) => {
    p.sourceLines.forEach((l, line) => l.ref && index.src.set(blockKey(l.ref.spine, l.ref.ord), { pair, line }))
    p.targetLines.forEach((l, line) => l.ref && index.tgt.set(blockKey(l.ref.spine, l.ref.ord), { pair, line }))
  })

  const cache = new Map()
  const alignmentFor = (pair) => {
    if (!cache.has(pair)) cache.set(pair, alignLines(pairs[pair].sourceLines, pairs[pair].targetLines))
    return cache.get(pair)
  }

  // pieces: [{ spine, ord, start, end }] selected on `side`. Returns
  // { own, other } as pieces to highlight on each side, or null when the
  // selection is not in aligned body text (a heading, front matter, …).
  return function link(side, pieces) {
    const hits = pieces
      .map((piece) => ({ piece, at: index[side].get(blockKey(piece.spine, piece.ord)) }))
      .filter((h) => h.at)
    if (hits.length === 0) return null
    const pair = hits[0].at.pair
    const alignment = alignmentFor(pair)
    const sentences = alignment[side]

    const hitSentences = []
    sentences.forEach((s, k) => {
      const touched = hits.some(
        (h) => h.at.pair === pair && h.at.line === s.line && s.start < h.piece.end && s.end > h.piece.start,
      )
      if (touched) hitSentences.push(k)
    })
    if (hitSentences.length === 0) return null

    const { own, other } = counterpartSentences(alignment, side, hitSentences)
    const toPieces = (whichSide, ids) => {
      const lines = whichSide === 'src' ? pairs[pair].sourceLines : pairs[pair].targetLines
      return ids.map((k) => {
        const s = alignment[whichSide][k]
        const { spine, ord } = lines[s.line].ref
        return { spine, ord, start: s.start, end: s.end, text: lines[s.line].text.slice(s.start, s.end) }
      })
    }
    return { own: toPieces(side, own), other: toPieces(OTHER[side], other) }
  }
}

// ---------------------------------------------------------------------------
// DOM positions <-> normalised text offsets
// ---------------------------------------------------------------------------

// points[i] is the DOM position of character i of the block's normalised
// text (whitespace runs collapsed to one space, ends trimmed), the same
// normalisation as normalizeText() in chapters.js.
function textPoints(el) {
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */)
  const points = []
  let pendingSpace = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.data
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) {
        if (points.length > 0 && !pendingSpace) pendingSpace = { node: n, offset: i }
        continue
      }
      if (pendingSpace) {
        points.push(pendingSpace)
        pendingSpace = null
      }
      points.push({ node: n, offset: i })
    }
  }
  return points
}

// Normalised offset of DOM position (node, offset) within a block.
function offsetAt(points, doc, node, offset) {
  const at = doc.createRange()
  at.setStart(node, offset)
  for (let i = 0; i < points.length; i++) {
    if (at.comparePoint(points[i].node, points[i].offset) >= 0) return i
  }
  return points.length
}

// The current selection in a rendered chapter, as pieces.
function selectionPieces(contents) {
  const doc = contents.document
  const sel = contents.window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return []
  const range = sel.getRangeAt(0)
  const pieces = []
  leafBlocks(doc).forEach(({ el }, ord) => {
    if (!range.intersectsNode(el)) return
    const points = textPoints(el)
    const start = el.contains(range.startContainer)
      ? offsetAt(points, doc, range.startContainer, range.startOffset)
      : 0
    const end = el.contains(range.endContainer)
      ? offsetAt(points, doc, range.endContainer, range.endOffset)
      : points.length
    if (end > start) pieces.push({ spine: contents.sectionIndex, ord, start, end })
  })
  return pieces
}

// DOM Ranges for the pieces that fall in this rendered chapter.
function piecesToRanges(doc, spine, pieces) {
  const blocks = leafBlocks(doc)
  const ranges = []
  for (const p of pieces) {
    if (p.spine !== spine || !blocks[p.ord]) continue
    const points = textPoints(blocks[p.ord].el)
    const end = Math.min(p.end, points.length)
    if (p.start >= end) continue
    const first = points[p.start]
    const last = points[end - 1]
    const r = doc.createRange()
    r.setStart(first.node, first.offset)
    r.setEnd(last.node, last.offset + 1)
    ranges.push(r)
  }
  return ranges
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

// One named highlight in one rendition. set() paints the pieces in every
// rendered chapter and returns the first painted { range, contents }.
function createPainter(rendition, name, color) {
  let pieces = []

  function paint(contents) {
    const win = contents.window
    if (!win || !win.CSS || !win.CSS.highlights || typeof win.Highlight !== 'function') return null
    const doc = contents.document
    const styleId = `${name}-style`
    if (!doc.getElementById(styleId) && doc.head) {
      const style = doc.createElement('style')
      style.id = styleId
      style.textContent = `::highlight(${name}) { background-color: ${color}; }`
      doc.head.appendChild(style)
    }
    const ranges = piecesToRanges(doc, contents.sectionIndex, pieces)
    if (ranges.length) win.CSS.highlights.set(name, new win.Highlight(...ranges))
    else win.CSS.highlights.delete(name)
    return ranges.length ? { range: ranges[0], contents } : null
  }

  // Re-apply when epubjs renders (or re-renders) a chapter.
  rendition.hooks.content.register((contents) => {
    if (pieces.length) paint(contents)
  })

  return {
    set(next) {
      pieces = next
      let first = null
      for (const contents of rendition.getContents()) {
        const hit = paint(contents)
        if (hit && !first) first = hit
      }
      return first
    },
  }
}

// The nearest ancestor of `el` that actually scrolls vertically.
function findScroller(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
  }
  return null
}

// Scroll the pane so `range` sits a third of the way down its view. Returns
// how far off it was (px) before scrolling, or 0 if it could not scroll.
function scrollToRange({ range, contents }) {
  const frame = contents.window && contents.window.frameElement
  const container = frame && findScroller(frame)
  if (!container) return 0
  const offset =
    frame.getBoundingClientRect().top +
    range.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    container.clientHeight / 3
  // Instant, not smooth: epubjs adds/removes chapters above the viewport as
  // the pane scrolls, which would leave a smooth animation aimed at a stale
  // position.
  container.scrollTop = Math.max(0, container.scrollTop + offset)
  return Math.abs(offset)
}

// A range's box in the top-level page's viewport coordinates.
function screenBox({ range, contents }) {
  const frame = contents.window && contents.window.frameElement
  if (!frame) return null
  const f = frame.getBoundingClientRect()
  const r = range.getBoundingClientRect()
  return { left: f.left + r.left, top: f.top + r.top, bottom: f.top + r.bottom, width: r.width }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

// Wires two renditions together. attach(side, rendition) as each pane is
// created (null when destroyed); setLinker() once the alignment is ready.
// `onStatus(text)` reports when a selection has no counterpart.
// `onLink({ original, translation, anchor })` fires after each successful
// selection with the matched passages (original book's text first, whichever
// side was selected) and the selection's on-screen box, for the popup; it
// fires with null when a new selection has no match.
export function createCrossHighlighter({ onStatus, onLink } = {}) {
  const panes = { src: null, tgt: null }
  let link = null
  let generation = 0

  function clearAll() {
    for (const pane of Object.values(panes)) {
      if (!pane) continue
      pane.picked.set([])
      pane.match.set([])
    }
  }

  async function reveal(pane, pieces) {
    const token = generation
    let hit = pane.match.set(pieces)
    if (!hit) {
      // The counterpart's chapter is not rendered yet: open it first.
      const section = pane.rendition.book.spine.get(pieces[0].spine)
      if (!section) return
      await pane.rendition.display(section.href)
      if (token !== generation) return
      await nextFrame()
      hit = pane.match.set(pieces)
    }
    // Scrolling can make epubjs load or drop neighbouring chapters, shifting
    // the layout, so re-measure and correct until the highlight stays put.
    for (let attempt = 0; hit && attempt < 6 && token === generation; attempt++) {
      if (scrollToRange(hit) < 20 && attempt > 0) break
      await wait(120)
      if (token !== generation) return
      hit = pane.match.set(pieces)
    }
  }

  function handleSelection(side, contents) {
    const sel = contents.window && contents.window.getSelection()
    if (!sel || sel.isCollapsed || !link) return
    const pieces = selectionPieces(contents)
    if (pieces.length === 0) return

    generation++
    clearAll()
    const result = link(side, pieces)
    if (!result) {
      onLink?.(null)
      onStatus?.('That passage has no aligned counterpart.')
      return
    }
    sel.removeAllRanges() // so the "picked" colour shows instead of the selection
    const picked = panes[side]?.picked.set(result.own)
    const other = panes[OTHER[side]]
    if (!other || result.other.length === 0) {
      onLink?.(null)
      onStatus?.('That passage has no counterpart in the other book.')
      return
    }
    onStatus?.('')
    const text = (pieces) => pieces.map((p) => p.text).join(' ')
    const [srcPieces, tgtPieces] = side === 'src' ? [result.own, result.other] : [result.other, result.own]
    onLink?.({
      original: text(srcPieces),
      translation: text(tgtPieces),
      anchor: picked ? screenBox(picked) : null,
    })
    reveal(other, result.other)
  }

  return {
    attach(side, rendition) {
      if (!rendition) {
        panes[side] = null
        return
      }
      panes[side] = {
        rendition,
        picked: createPainter(rendition, 'xh-picked', PICKED_COLOR),
        match: createPainter(rendition, 'xh-match', MATCH_COLOR),
      }
      const onRelease = (_event, contents) => handleSelection(side, contents)
      for (const type of ['mouseup', 'touchend', 'keyup']) rendition.on(type, onRelease)
    },
    setLinker(next) {
      link = next
    },
  }
}

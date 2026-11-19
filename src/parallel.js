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

import { alignLines, beadFlag, beadLengthP, counterpartSentences, FLAG_LEVELS } from './align.js'
import { blockKey, leafBlocks } from './chapters.js'

const PICKED_COLOR = 'rgba(255, 190, 0, 0.45)' // what you selected
const MATCH_COLOR = 'rgba(70, 150, 255, 0.35)' // its counterpart
// The same fills on a dark page (reading theme "Dark", see readingSettings.js),
// by highlight name: stronger, so they still stand out behind light text.
export const DARK_HIGHLIGHT_FILLS = {
  'xh-picked': 'rgba(255, 176, 0, 0.42)',
  'xh-match': 'rgba(80, 150, 255, 0.45)',
  'xh-hover': 'rgba(170, 200, 240, 0.22)',
}
const OTHER = { src: 'tgt', tgt: 'src' }
// How long a touch selection must stay unchanged before it counts as made.
const TOUCH_SELECTION_SETTLE_MS = 400

// ---------------------------------------------------------------------------
// Alignment lookup
// ---------------------------------------------------------------------------

// `pairs` are matched section pairs from alignSections(). Sentence alignment
// of a pair is computed the first time it is needed, then cached.
// Returns { link, heat }.
export function createLinker(pairs) {
  const index = { src: new Map(), tgt: new Map() }
  const pairsBySpine = { src: new Map(), tgt: new Map() }
  pairs.forEach((p, pair) => {
    for (const [side, lines] of [['src', p.sourceLines], ['tgt', p.targetLines]]) {
      lines.forEach((l, line) => {
        if (!l.ref) return
        index[side].set(blockKey(l.ref.spine, l.ref.ord), { pair, line })
        if (!pairsBySpine[side].has(l.ref.spine)) pairsBySpine[side].set(l.ref.spine, new Set())
        pairsBySpine[side].get(l.ref.spine).add(pair)
      })
    }
  })

  const cache = new Map()
  const alignmentFor = (pair) => {
    if (!cache.has(pair)) cache.set(pair, alignLines(pairs[pair].sourceLines, pairs[pair].targetLines))
    return cache.get(pair)
  }
  // Sentence ids on one side of a pair -> pieces locating them on screen.
  const toPieces = (pair, side, ids) => {
    const alignment = alignmentFor(pair)
    const lines = side === 'src' ? pairs[pair].sourceLines : pairs[pair].targetLines
    return ids.map((k) => {
      const s = alignment[side][k]
      const { spine, ord } = lines[s.line].ref
      return { spine, ord, start: s.start, end: s.end, text: lines[s.line].text.slice(s.start, s.end) }
    })
  }
  const beadRange = (bead, side) => (side === 'src' ? [bead.s, bead.sn] : [bead.t, bead.tn])

  // The `span` sentences on each side of a bead, as text — the neighbouring
  // lines just before and after it in each book. Sent to the verifier so it can
  // tell an off-by-one alignment slip (the real counterpart is right next door)
  // from a genuine divergence. Clamped to the section's sentence range.
  function contextFor(pair, bead, span = 2) {
    const alignment = alignmentFor(pair)
    const ids = (from, to, max) => {
      const out = []
      for (let k = Math.max(0, from); k < Math.min(max, to); k++) out.push(k)
      return out
    }
    const text = (side, list) => toPieces(pair, side, list).map((p) => p.text).join(' ')
    const [s, sn] = [bead.s, bead.sn]
    const [t, tn] = [bead.t, bead.tn]
    const srcN = alignment.src.length
    const tgtN = alignment.tgt.length
    return {
      beforeSrc: text('src', ids(s - span, s, srcN)),
      afterSrc: text('src', ids(s + sn, s + sn + span, srcN)),
      beforeTgt: text('tgt', ids(t - span, t, tgtN)),
      afterTgt: text('tgt', ids(t + tn, t + tn + span, tgtN)),
    }
  }

  // pieces: [{ spine, ord, start, end }] selected on `side`. Returns
  // { own, other, beads } — pieces to highlight on each side plus the beads
  // involved — or null when the selection is not in aligned body text (a
  // heading, front matter, …).
  function link(side, pieces) {
    const hits = pieces
      .map((piece) => ({ piece, at: index[side].get(blockKey(piece.spine, piece.ord)) }))
      .filter((h) => h.at)
    if (hits.length === 0) return null
    const pair = hits[0].at.pair
    const alignment = alignmentFor(pair)

    const hitSentences = []
    alignment[side].forEach((s, k) => {
      const touched = hits.some(
        (h) => h.at.pair === pair && h.at.line === s.line && s.start < h.piece.end && s.end > h.piece.start,
      )
      if (touched) hitSentences.push(k)
    })
    if (hitSentences.length === 0) return null

    const { own, other } = counterpartSentences(alignment, side, hitSentences)
    const ownSet = new Set(own)
    const beads = alignment.beads.filter((b) => {
      const [start, count] = beadRange(b, side)
      for (let k = start; k < start + count; k++) if (ownSet.has(k)) return true
      return false
    })
    return { own: toPieces(pair, side, own), other: toPieces(pair, OTHER[side], other), beads }
  }

  // Both sides of a bead as pieces, plus its text and a content key.
  const beadInfo = new WeakMap()
  function describe(pair, bead) {
    if (!beadInfo.has(bead)) {
      const idsOf = (side) => {
        const [start, count] = beadRange(bead, side)
        return Array.from({ length: count }, (_, k) => start + k)
      }
      const src = toPieces(pair, 'src', idsOf('src'))
      const tgt = toPieces(pair, 'tgt', idsOf('tgt'))
      const original = src.map((p) => p.text).join(' ')
      const translation = tgt.map((p) => p.text).join(' ')
      beadInfo.set(bead, { src, tgt, original, translation, key: pairKey(original, translation) })
    }
    return beadInfo.get(bead)
  }

  // Sentences in chapter file `spine` on `side`, grouped by the level
  // `classify(bead, info)` gives them (null = not shown). Defaults to the
  // Gale–Church flags: { unmatched, mismatch, loose } (see beadFlag).
  function heat(side, spine, classify = beadFlag) {
    const out = {}
    for (const pair of pairsBySpine[side].get(spine) || []) {
      for (const bead of alignmentFor(pair).beads) {
        const info = describe(pair, bead)
        const level = classify(bead, info)
        if (!level) continue
        for (const piece of info[side]) {
          if (piece.spine === spine) (out[level] ||= []).push(piece)
        }
      }
    }
    return out
  }

  // The flagged bead covering (spine, block ord, char offset) on `side`, or
  // null. `classifiers` is { gc, scan, issue } — a classify(bead, info) for each
  // active view (null when off). Used for hover + click on an underlined
  // passage. Beads partition the text, so the first covering bead is the one.
  function issueAt(side, spine, ord, offset, classifiers) {
    for (const pair of pairsBySpine[side].get(spine) || []) {
      for (const bead of alignmentFor(pair).beads) {
        const info = describe(pair, bead)
        const covers = info[side].some(
          (p) => p.spine === spine && p.ord === ord && offset >= p.start && offset < p.end,
        )
        if (!covers) continue
        const gcLevel = classifiers.gc ? classifiers.gc(bead, info) : null
        const scanLevel = classifiers.scan ? classifiers.scan(bead, info) : null
        const issueLevel = classifiers.issue ? classifiers.issue(bead, info) : null
        if (!gcLevel && !scanLevel && !issueLevel) return null
        return { bead, info, pieces: info[side].filter((p) => p.spine === spine), gcLevel, scanLevel, issueLevel }
      }
    }
    return null
  }

  // Every bead in the book, in reading order:
  // [{ key, original, translation, src, tgt, gcFlag, gcP, section }].
  // Aligning a long book takes a few seconds, so this yields to the page
  // between sections and reports progress as (done, total).
  async function allBeads(onProgress) {
    const out = []
    for (let pair = 0; pair < pairs.length; pair++) {
      for (const bead of alignmentFor(pair).beads) {
        out.push({
          ...describe(pair, bead),
          context: contextFor(pair, bead),
          gcFlag: beadFlag(bead),
          gcP: beadLengthP(bead),
          section: pairs[pair].title,
        })
      }
      onProgress?.(pair + 1, pairs.length)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return out
  }

  return { link, heat, allBeads, issueAt }
}

// A short, stable key for a passage pair's text (53-bit cyrb53 hash), used to
// cache scan results: the same text always maps to the same result, however
// the alignment code changes around it.
export function pairKey(original, translation) {
  const str = `${original}\u0000${translation}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
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
  if (!pieces.some((p) => p.spine === spine)) return []
  const blocks = leafBlocks(doc)
  const pointsByOrd = new Map() // a paragraph often holds several pieces
  const ranges = []
  for (const p of pieces) {
    if (p.spine !== spine || !blocks[p.ord]) continue
    if (!pointsByOrd.has(p.ord)) pointsByOrd.set(p.ord, textPoints(blocks[p.ord].el))
    const points = pointsByOrd.get(p.ord)
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

// Paint `pieces` in one rendered chapter as the named highlight, styled by the
// CSS declaration `decl` (a background fill for selections, an underline for
// flagged passages). Higher `priority` draws on top where highlights overlap.
// Returns the first painted { range, contents }, or null.
function paintHighlight(contents, name, decl, priority, pieces) {
  const win = contents.window
  if (!win || !win.CSS || !win.CSS.highlights || typeof win.Highlight !== 'function') return null
  const doc = contents.document
  const styleId = `${name}-style`
  if (!doc.getElementById(styleId) && doc.head) {
    const style = doc.createElement('style')
    style.id = styleId
    style.textContent = `::highlight(${name}) { ${decl} }`
    doc.head.appendChild(style)
  }
  const ranges = piecesToRanges(doc, contents.sectionIndex, pieces)
  if (ranges.length === 0) {
    win.CSS.highlights.delete(name)
    return null
  }
  const highlight = new win.Highlight(...ranges)
  highlight.priority = priority
  win.CSS.highlights.set(name, highlight)
  return { range: ranges[0], contents }
}

const fill = (color) => `background-color: ${color};`
const underline = (color, thickness) =>
  `text-decoration-line: underline; text-decoration-color: ${color};` +
  ` text-decoration-thickness: ${thickness}px; text-underline-offset: 2px;`

// Safari — and every other WebKit browser, which includes all browsers on
// iOS — paints a ::highlight() underline twice: once in the colour asked for,
// once in the text colour, which blurs the colour coding of flagged passages
// (crimson translation error vs purple alignment error). Background fills
// render correctly there, so WebKit gets a light tint instead. It's a
// rendering bug no feature test can see, hence the user-agent check.
export const FLAG_STYLE =
  typeof navigator !== 'undefined' &&
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(navigator.userAgent)
    ? 'tint'
    : 'underline'

// A flag's colour as a background tint: the same hue, stronger for the worse
// flags (the underline's thickness is what encodes severity).
export function tintColor(color, thickness) {
  const alpha = Math.min(0.32, 0.1 * thickness).toFixed(2)
  return color.replace(/rgba?\(\s*([^,]+),\s*([^,]+),\s*([^,)]+)(?:,[^)]*)?\)/, `rgba($1, $2, $3, ${alpha})`)
}
const flagDecl = (color, thickness) =>
  FLAG_STYLE === 'tint' ? fill(tintColor(color, thickness)) : underline(color, thickness)

// Legend swatch matching how flagged passages look in this browser.
export const flagSwatchStyle = ([color, thickness]) =>
  FLAG_STYLE === 'tint'
    ? { background: tintColor(color, thickness), height: '12px' }
    : { borderBottom: `3px solid ${color}` }

// One background highlight in one rendition. set() paints the pieces in every
// rendered chapter and returns the first painted { range, contents }.
function createPainter(rendition, name, color, priority) {
  let pieces = []
  // Re-apply when epubjs renders (or re-renders) a chapter.
  rendition.hooks.content.register((contents) => {
    if (pieces.length) paintHighlight(contents, name, fill(color), priority, pieces)
  })
  return {
    set(next) {
      pieces = next
      let first = null
      for (const contents of rendition.getContents()) {
        const hit = paintHighlight(contents, name, fill(color), priority, pieces)
        if (hit && !first) first = hit
      }
      return first
    },
  }
}

// Heat maps for one pane: each rendered chapter's sentences, tinted by the
// level a classifier gives their bead. Chapters are computed as they render,
// so a long book costs nothing up front. Two maps exist:
//   Gale–Church — beadFlag (align.js): length-based suspicion
//   ChatGPT     — scanLevel (scan.js): the cheap model's whole-book scan
// Underline styles for flagged passages (they replace the old background tint):
// red for Gale–Church, blue for the ChatGPT scan, thicker and stronger the
// worse the passage. [color, thickness]. Keys are beadFlag / scanLevel levels.
export const GC_UNDERLINE = {
  unmatched: ['rgba(220, 0, 0, 0.95)', 3], // no counterpart: omitted or added
  mismatch: ['rgba(220, 0, 0, 0.85)', 2], // length fit p < 1%
  loose: ['rgba(221, 45, 45, 0.55)', 1.5], // length fit p < 5%
}
export const SCAN_UNDERLINE = {
  not_matching: ['rgba(0, 60, 230, 0.95)', 3], // not a translation of each other
  bad: ['rgba(0, 90, 255, 0.9)', 2.5], // ChatGPT score 1-3
  weak: ['rgba(0, 90, 255, 0.5)', 1.5], // ChatGPT score 4-5
}
// Confirmed issues (issues.js): a Gale–Church red signal a strong model has
// agreed is genuinely bad. Only two levels, both thick — these are the verdicts
// the "Issues" view shows. [color, thickness]. Keys are issueLevel() levels.
export const ISSUE_UNDERLINE = {
  translation: ['rgba(200, 0, 40, 0.95)', 3], // confirmed translation error (crimson)
  alignment: ['rgba(150, 0, 200, 0.95)', 3], // confirmed alignment error (purple)
  misaligned: ['rgba(120, 120, 120, 0.7)', 1.5], // dev-only: the aligner slipped (grey, hidden from readers)
}
const HOVER_FILL = 'rgba(90, 120, 160, 0.18)' // emphasis while hovering an issue

function createHeatPainter(rendition, side, getLinker, { prefix, styles, classify }) {
  let enabled = false
  const paint = (contents) => {
    const linker = getLinker()
    const levels = enabled && linker ? linker.heat(side, contents.sectionIndex, classify()) : {}
    for (const level of Object.keys(styles)) {
      const [color, thickness] = styles[level]
      paintHighlight(contents, `${prefix}-${level}`, flagDecl(color, thickness), 0, levels[level] || [])
    }
  }
  rendition.hooks.content.register((contents) => {
    if (enabled) paint(contents)
  })
  return {
    set(next) {
      enabled = next
      for (const contents of rendition.getContents()) paint(contents)
    },
    refresh() {
      if (enabled) for (const contents of rendition.getContents()) paint(contents)
    },
  }
}

// How Gale–Church judged the beads behind a selection, for the popup:
// { shapes: ['1→2', …], flag: worst flag or null, p: worst length fit or null }.
function describeBeads(beads) {
  let flag = null
  let p = null
  for (const b of beads) {
    const f = beadFlag(b)
    if (f && (!flag || FLAG_LEVELS.indexOf(f) < FLAG_LEVELS.indexOf(flag))) flag = f
    const bp = beadLengthP(b)
    if (bp !== null && (p === null || bp < p)) p = bp
  }
  return { shapes: beads.map((b) => `${b.sn}→${b.tn}`), flag, p }
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

// A mouse event's point in the top-level page's viewport coordinates.
function eventBox(contents, event) {
  const frame = contents.window && contents.window.frameElement
  if (!frame) return null
  const f = frame.getBoundingClientRect()
  const x = f.left + (event.clientX || 0)
  const y = f.top + (event.clientY || 0)
  return { left: x, top: y - 10, bottom: y + 10, width: 0 }
}

// leafBlocks() is stable per rendered document; cache it for hover hit-testing.
const blockCache = new WeakMap()
function leafBlocksCached(doc) {
  let blocks = blockCache.get(doc)
  if (!blocks) blockCache.set(doc, (blocks = leafBlocks(doc)))
  return blocks
}

// Which block + normalised char offset a mouse event points at, as
// { spine, ord, offset }, or null when it is not over body text.
function locate(contents, event) {
  const doc = contents.document
  const x = event.clientX
  const y = event.clientY
  if (x == null || y == null) return null
  let node = null
  let offset = 0
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y)
    if (r) {
      node = r.startContainer
      offset = r.startOffset
    }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y)
    if (p) {
      node = p.offsetNode
      offset = p.offset
    }
  }
  if (!node) return null
  const blocks = leafBlocksCached(doc)
  const ord = blocks.findIndex((b) => b.el.contains(node))
  if (ord < 0) return null
  return { spine: contents.sectionIndex, ord, offset: offsetAt(textPoints(blocks[ord].el), doc, node, offset) }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

// Wires two renditions together. attach(side, rendition) as each pane is
// created (null when destroyed); setLinker() once the alignment is ready.
// `onStatus(text)` reports when a selection has no counterpart.
// `onLink({ original, translation, anchor, gc })` fires after each successful
// selection with the matched passages (original book's text first, whichever
// side was selected), the selection's on-screen box, and how Gale–Church
// judged them (see describeBeads), for the popup; it fires with null when a
// new selection has no match. setHeat(true) shows the Gale–Church heat map;
// setScanView(true, classify) shows the ChatGPT scan's (see scan.js).
// focus({ src, tgt }) highlights a pair and scrolls both panes to it.
export function createCrossHighlighter({ onStatus, onLink, onIssue } = {}) {
  const panes = { src: null, tgt: null }
  let linker = null
  let heatOn = false
  let scanOn = false
  let scanClassify = () => null
  let issuesOn = false
  let issueClassify = () => null
  let generation = 0

  function clearAll() {
    for (const pane of Object.values(panes)) {
      if (!pane) continue
      pane.picked.set([])
      pane.match.set([])
      pane.hover?.set([])
    }
  }

  // Paint `pieces` with `painter` in `pane` and scroll the pane to them,
  // opening their chapter first if it is not rendered.
  async function reveal(pane, painter, pieces) {
    if (!pane || pieces.length === 0) return
    const token = generation
    let hit = painter.set(pieces)
    if (!hit) {
      const section = pane.rendition.book.spine.get(pieces[0].spine)
      if (!section) return
      await pane.rendition.display(section.href)
      if (token !== generation) return
      await nextFrame()
      hit = painter.set(pieces)
    }
    // Scrolling can make epubjs load or drop neighbouring chapters, shifting
    // the layout, so re-measure and correct until the highlight stays put.
    for (let attempt = 0; hit && attempt < 6 && token === generation; attempt++) {
      if (scrollToRange(hit) < 20 && attempt > 0) break
      await wait(120)
      if (token !== generation) return
      hit = painter.set(pieces)
    }
  }

  function handleSelection(side, contents) {
    const sel = contents.window && contents.window.getSelection()
    if (!sel || sel.isCollapsed || !linker) return
    const pieces = selectionPieces(contents)
    if (pieces.length === 0) return

    generation++
    clearAll()
    const result = linker.link(side, pieces)
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
      gc: describeBeads(result.beads),
    })
    reveal(other, other.match, result.other)
  }

  return {
    attach(side, rendition) {
      if (!rendition) {
        panes[side] = null
        return
      }
      panes[side] = {
        rendition,
        // Selection colours sit above the issue underlines where they overlap.
        picked: createPainter(rendition, 'xh-picked', PICKED_COLOR, 2),
        match: createPainter(rendition, 'xh-match', MATCH_COLOR, 2),
        hover: createPainter(rendition, 'xh-hover', HOVER_FILL, 1),
        heat: createHeatPainter(rendition, side, () => linker, {
          prefix: 'gc',
          styles: GC_UNDERLINE,
          classify: () => beadFlag,
        }),
        scan: createHeatPainter(rendition, side, () => linker, {
          prefix: 'scan',
          styles: SCAN_UNDERLINE,
          classify: () => scanClassify,
        }),
        issues: createHeatPainter(rendition, side, () => linker, {
          prefix: 'issue',
          styles: ISSUE_UNDERLINE,
          classify: () => issueClassify,
        }),
      }
      if (heatOn) panes[side].heat.set(true)
      if (scanOn) panes[side].scan.set(true)
      if (issuesOn) panes[side].issues.set(true)
      const onRelease = (_event, contents) => handleSelection(side, contents)
      for (const type of ['mouseup', 'touchend', 'keyup']) rendition.on(type, onRelease)

      // Phones: a long-press selects text natively, and the selection is
      // finished — or adjusted with the handles — after the finger has lifted.
      // touchend fires too early to see it and handle-dragging fires no events
      // at all, so the phone's own selection just sat there. After a touch,
      // act once the selection has stopped changing instead. (Not for the
      // mouse: there selectionchange fires mid-drag, and mouseup is reliable.)
      rendition.hooks.content.register((contents) => {
        const doc = contents.document
        if (!doc) return
        let touch = false
        let timer = 0
        doc.addEventListener('touchstart', () => (touch = true), { passive: true })
        doc.addEventListener('pointerdown', (e) => (touch = e.pointerType === 'touch'), { passive: true })
        doc.addEventListener('mousedown', () => (touch = false), { passive: true })
        doc.addEventListener('selectionchange', () => {
          if (!touch) return
          clearTimeout(timer)
          timer = setTimeout(() => handleSelection(side, contents), TOUCH_SELECTION_SETTLE_MS)
        })
      })

      // Hover + click on flagged (underlined) passages, only while a view is on.
      const findIssue = (contents, event) => {
        if (!linker || (!heatOn && !scanOn && !issuesOn)) return null
        const loc = locate(contents, event)
        if (!loc) return null
        return linker.issueAt(side, loc.spine, loc.ord, loc.offset, {
          gc: heatOn ? beadFlag : null,
          scan: scanOn ? scanClassify : null,
          issue: issuesOn ? issueClassify : null,
        })
      }
      let hoverRaf = 0
      let pending = null
      rendition.on('mousemove', (event, contents) => {
        pending = { event, contents }
        if (hoverRaf) return
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0
          const { event, contents } = pending
          const issue = findIssue(contents, event)
          const body = contents.document && contents.document.body
          if (body) body.style.cursor = issue ? 'pointer' : ''
          panes[side]?.hover.set(issue ? issue.pieces : [])
        })
      })
      rendition.on('click', (event, contents) => {
        const issue = findIssue(contents, event)
        if (!issue) return
        onIssue?.({
          original: issue.info.original,
          translation: issue.info.translation,
          anchor: eventBox(contents, event),
          gc: issue.gcLevel ? describeBeads([issue.bead]) : null,
          scanKey: issue.scanLevel ? issue.info.key : null,
          scanLevel: issue.scanLevel || null,
          issueKey: issue.issueLevel ? issue.info.key : null,
          issueLevel: issue.issueLevel || null,
        })
      })
    },
    setLinker(next) {
      linker = next
      for (const pane of Object.values(panes)) {
        pane?.heat.refresh()
        pane?.scan.refresh()
        pane?.issues.refresh()
      }
    },
    setHeat(on) {
      heatOn = on
      for (const pane of Object.values(panes)) pane?.heat.set(on)
    },
    // classify(bead, info) -> level in SCAN_UNDERLINE, or null.
    setScanView(on, classify) {
      scanOn = on
      if (classify) scanClassify = classify
      for (const pane of Object.values(panes)) pane?.scan.set(on)
    },
    // The confirmed-issues view: classify(bead, info) -> level in
    // ISSUE_UNDERLINE ('alignment' | 'translation'), or null. Reads baked
    // verdicts; no API call.
    setIssues(on, classify) {
      issuesOn = on
      if (classify) issueClassify = classify
      for (const pane of Object.values(panes)) pane?.issues.set(on)
    },
    focus({ src, tgt }) {
      generation++
      clearAll()
      onLink?.(null)
      reveal(panes.src, panes.src?.picked, src)
      reveal(panes.tgt, panes.tgt?.match, tgt)
    },
  }
}

// Where the reader is in a book: resume where you left off, progress, and
// jumping to a chapter from the table of contents.
//
// A place in a book is { spine, ord }: the chapter file and the paragraph's
// position in it (leafBlocks in chapters.js), the same identity alignment and
// highlighting use. It survives text size, font and margin changes (unlike a
// scroll offset) and needs no epubjs CFI. epubjs renders the whole book up
// front into one scroll box per pane (rendition.manager.container).

import { leafBlocks } from './chapters.js'

// ---------------------------------------------------------------------------
// Finding things in a rendered pane
// ---------------------------------------------------------------------------

export function scroller(rendition) {
  return rendition && rendition.manager && rendition.manager.container
}

function contentsFor(rendition, spine) {
  return rendition.getContents().find((c) => c.sectionIndex === spine) || null
}

// Rendered chapters with their iframes, in reading order.
function frames(rendition) {
  return rendition
    .getContents()
    .map((c) => ({ contents: c, frame: c.window && c.window.frameElement }))
    .filter((x) => x.frame && x.contents.document)
}

const blockCache = new WeakMap()
function blocksOf(doc) {
  let blocks = blockCache.get(doc)
  if (!blocks) blockCache.set(doc, (blocks = leafBlocks(doc)))
  return blocks
}

// The paragraph at the top of the pane's view: { spine, ord }, or null.
export function placeAtTop(rendition) {
  const box = scroller(rendition)
  if (!box) return null
  const top = box.getBoundingClientRect().top + 4
  for (const { contents, frame } of frames(rendition)) {
    const f = frame.getBoundingClientRect()
    if (f.bottom <= top || f.top > top) continue
    // The first paragraph whose bottom is below the top edge.
    const blocks = blocksOf(contents.document)
    const ord = blocks.findIndex(({ el }) => f.top + el.getBoundingClientRect().bottom > top)
    return ord === -1 ? null : { spine: contents.sectionIndex, ord }
  }
  return null
}

// How far through the book the view is, 0-100.
export function percentRead(rendition) {
  const box = scroller(rendition)
  if (!box) return 0
  const max = box.scrollHeight - box.clientHeight
  return max > 0 ? Math.min(100, Math.max(0, (100 * box.scrollTop) / max)) : 0
}

// ---------------------------------------------------------------------------
// Scrolling to a place
// ---------------------------------------------------------------------------
//
// Chapters above the target keep growing for a while after the book opens
// (images, fonts), which pushes the target down. So after the first jump the
// target is held in place until the layout settles, for up to HOLD_MAX_MS,
// unless the reader scrolls, clicks or types first (see onReaderInput).

const TOP_GAP = 16 // px between the pane's top edge and the target
const HOLD_MIN_MS = 800
const HOLD_MAX_MS = 6000
const holding = new WeakMap() // scroll box -> stop() of the hold running there

// Scroll so that `find()` (returning { el, frame } or null) sits at the top.
// Resolves true once it has been shown, false if it never appeared.
function holdAtTop(rendition, find) {
  const box = scroller(rendition)
  if (!box) return Promise.resolve(false)
  holding.get(box)?.()
  return new Promise((resolve) => {
    const started = performance.now()
    let stable = 0
    let shown = false
    let raf = 0
    let unlisten = () => {}
    const stop = () => {
      cancelAnimationFrame(raf)
      unlisten()
      if (holding.get(box) === stop) holding.delete(box)
      resolve(shown)
    }
    unlisten = onReaderInput(box, stop)
    holding.set(box, stop)
    const step = () => {
      const hit = find()
      if (hit) {
        const delta =
          hit.frame.getBoundingClientRect().top + hit.el.getBoundingClientRect().top - box.getBoundingClientRect().top - TOP_GAP
        if (Math.abs(delta) > 1) {
          box.scrollTop += delta
          stable = 0
        } else {
          stable++
        }
        shown = true
      }
      const elapsed = performance.now() - started
      if (elapsed > HOLD_MAX_MS || (shown && elapsed > HOLD_MIN_MS && stable >= 15)) return stop()
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  })
}

// Call `handler` the first time the reader scrolls, clicks, touches or types
// in a pane. Wheel and key events over the text happen inside the chapter
// iframes and never reach the pane, so each rendered chapter is listened to
// as well. Returns a function that stops listening.
const INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown']
export function onReaderInput(box, handler) {
  const targets = [box, ...[...box.querySelectorAll('iframe')].map((f) => f.contentDocument).filter(Boolean)]
  for (const t of targets) for (const type of INPUTS) t.addEventListener(type, handler, { capture: true, passive: true })
  return () => {
    for (const t of targets) for (const type of INPUTS) t.removeEventListener(type, handler, { capture: true })
  }
}

// Scroll a pane to { spine, ord }.
export function scrollToPlace(rendition, place) {
  if (!place) return Promise.resolve(false)
  return holdAtTop(rendition, () => {
    const c = contentsFor(rendition, place.spine)
    const frame = c && c.window && c.window.frameElement
    const block = c && blocksOf(c.document)[place.ord]
    return frame && block ? { el: block.el, frame } : null
  })
}

// Scroll a pane to a contents entry (see tableOfContents).
export function scrollToEntry(rendition, entry) {
  return holdAtTop(rendition, () => {
    const c = contentsFor(rendition, entry.spine)
    const frame = c && c.window && c.window.frameElement
    if (!frame) return null
    const el = (entry.fragment && c.document.getElementById(entry.fragment)) || c.document.body
    return el ? { el, frame } : null
  })
}

// The first paragraph at or after a contents entry's target: { spine, ord }.
export function placeOfEntry(rendition, entry) {
  const c = contentsFor(rendition, entry.spine)
  if (!c) return { spine: entry.spine, ord: 0 }
  const target = entry.fragment && c.document.getElementById(entry.fragment)
  if (!target) return { spine: entry.spine, ord: 0 }
  const blocks = blocksOf(c.document)
  const ord = blocks.findIndex(
    ({ el }) => el === target || target.contains(el) || el.contains(target) || target.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
  )
  return { spine: entry.spine, ord: Math.max(0, ord) }
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

// The book's own contents list, flattened in reading order:
// [{ label, depth, spine, fragment, href }]. Entries pointing outside the
// book's reading order are dropped.
export async function tableOfContents(rendition) {
  const book = rendition.book
  await book.loaded.navigation
  const out = []
  const walk = (items, depth) => {
    for (const item of items || []) {
      const href = item.href || ''
      const [path, fragment = ''] = href.split('#')
      const section = book.spine.get(path) || book.spine.get(href)
      const label = (item.label || '').replace(/\s+/g, ' ').trim()
      if (section && label) out.push({ label, depth, spine: section.index, fragment, href })
      walk(item.subitems, depth + 1)
    }
  }
  walk(book.navigation.toc, 0)
  return out
}

// Index of the entry the view is in: the last one whose target is at or
// above the top of the pane. -1 before the first.
export function currentEntry(rendition, entries) {
  const box = scroller(rendition)
  if (!box || entries.length === 0) return -1
  const top = box.getBoundingClientRect().top + TOP_GAP + 8
  const byspine = new Map(rendition.getContents().map((c) => [c.sectionIndex, c]))
  let current = -1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const c = byspine.get(e.spine)
    const frame = c && c.window && c.window.frameElement
    if (!frame) continue
    const el = (e.fragment && c.document.getElementById(e.fragment)) || c.document.body
    if (!el) continue
    const y = frame.getBoundingClientRect().top + el.getBoundingClientRect().top
    if (y <= top) current = i
    else if (current !== -1) break
  }
  return current
}

// ---------------------------------------------------------------------------
// The matching place in the other book
// ---------------------------------------------------------------------------

// The place in the other book aligned with `place` on `side`, via the linker
// (parallel.js): the first aligned paragraph at or after it, a little further
// on if it is a heading or untranslated front matter. Null if none is near.
export function counterpartPlace(linker, side, place, rendition) {
  if (!linker || !place) return null
  const spines = rendition.getContents().map((c) => c.sectionIndex).filter((s) => s >= place.spine).sort((a, b) => a - b)
  let tries = 0
  for (const spine of spines.slice(0, 4)) {
    const c = contentsFor(rendition, spine)
    const count = c ? blocksOf(c.document).length : 0
    for (let ord = spine === place.spine ? place.ord : 0; ord < count && tries < 400; ord++, tries++) {
      const hit = linker.link(side, [{ spine, ord, start: 0, end: 1 }])
      if (hit && hit.other.length) return { spine: hit.other[0].spine, ord: hit.other[0].ord }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Remembering the place, per book, in this browser
// ---------------------------------------------------------------------------

const key = (bookId) => `verbatim.position.${bookId}`

// { src?: { spine, ord }, tgt?: { spine, ord } } for a book, or {}.
export function loadPositions(bookId) {
  try {
    const saved = JSON.parse(localStorage.getItem(key(bookId)) || '{}') || {}
    const valid = (p) => p && Number.isInteger(p.spine) && Number.isInteger(p.ord) && p.spine >= 0 && p.ord >= 0
    const out = {}
    for (const side of ['src', 'tgt']) if (valid(saved[side])) out[side] = { spine: saved[side].spine, ord: saved[side].ord }
    return out
  } catch {
    return {}
  }
}

export function savePosition(bookId, side, place) {
  try {
    const all = loadPositions(bookId)
    all[side] = place
    localStorage.setItem(key(bookId), JSON.stringify(all))
  } catch {
    /* storage unavailable: the place just isn't remembered */
  }
}

// ---------------------------------------------------------------------------
// Tracking one pane
// ---------------------------------------------------------------------------

// Wait until chapter `spine` is rendered. Resolves true, or false on timeout
// or when `abort()` turns true.
function waitForChapter(rendition, spine, timeout, abort) {
  const started = performance.now()
  return new Promise((resolve) => {
    const check = () => {
      if (abort()) return resolve(false)
      if (contentsFor(rendition, spine)) return resolve(true)
      if (performance.now() - started > timeout) return resolve(false)
      setTimeout(check, 150)
    }
    check()
  })
}

const RESUME_WAIT_MS = 30000 // a long book can take a while to render up to the saved chapter
const SAVE_DELAY_MS = 400

// Follow one pane as the reader moves through the book:
// - reopens it where it was last left (per book and side, in this browser),
//   unless the reader starts scrolling first;
// - remembers the place as they read;
// - reports progress, onProgress({ percent, entry, label }), whenever the
//   chapter or whole percent changes;
// - reports the book's contents once, onContents({ entries, title, language }).
// `bookId` null: nothing is remembered. Returns a function that stops it.
export function trackPlace(rendition, { bookId, side, onProgress, onContents }) {
  let alive = true
  let entries = []
  let box = null
  let ready = false // saving starts once the saved place is restored (or skipped)
  let saveTimer = 0
  let raf = 0
  let last = { percent: null, entry: null }

  const report = () => {
    raf = 0
    if (!alive || !box) return
    const percent = Math.round(percentRead(rendition))
    const entry = currentEntry(rendition, entries)
    if (percent === last.percent && entry === last.entry) return
    last = { percent, entry }
    onProgress?.({ percent, entry, label: entry >= 0 ? entries[entry].label : '' })
  }
  const onScroll = () => {
    if (!raf) raf = requestAnimationFrame(report)
    if (!ready || !bookId) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const place = placeAtTop(rendition)
      if (place) savePosition(bookId, side, place)
    }, SAVE_DELAY_MS)
  }

  tableOfContents(rendition)
    .catch(() => [])
    .then((list) => {
      if (!alive) return
      entries = list
      const meta = (rendition.book.packaging && rendition.book.packaging.metadata) || {}
      onContents?.({ entries, title: meta.title || '', language: meta.language || '' })
      report()
    })

  // epubjs creates the scroll box just after "started", once the book opens.
  const scrollBox = () =>
    new Promise((resolve) => {
      const started = performance.now()
      const check = () => {
        if (!alive) return resolve(null)
        const found = scroller(rendition)
        if (found) return resolve(found)
        if (performance.now() - started > RESUME_WAIT_MS) return resolve(null)
        setTimeout(check, 50)
      }
      check()
    })

  rendition.started.then(async () => {
    box = await scrollBox()
    if (!alive || !box) return
    box.addEventListener('scroll', onScroll, { passive: true })
    const saved = bookId ? loadPositions(bookId)[side] : null
    if (saved) {
      // Moving away from the very top before the chapter is ready means the
      // reader has started reading here; leave them be.
      const moved = () => !alive || box.scrollTop > 50
      if (await waitForChapter(rendition, saved.spine, RESUME_WAIT_MS, moved)) await scrollToPlace(rendition, saved)
    }
    ready = true
    report()
  })

  return () => {
    alive = false
    clearTimeout(saveTimer)
    cancelAnimationFrame(raf)
    box?.removeEventListener('scroll', onScroll)
  }
}

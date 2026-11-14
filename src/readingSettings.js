// Reading comfort settings: text size, font, line spacing, margins and colour
// theme. One set applies to every open book (both panes of the parallel view
// move together, so their lines stay comparable) and is remembered in this
// browser.
//
// The book's text lives in epubjs iframes, one per chapter, each with the
// book's own stylesheet. Settings are applied by putting one <style> element
// of our own into every chapter (readerCss); its rules use !important so they
// win over the book's, and choosing "Book" for a setting simply leaves that
// rule out. Margins are padding inside the chapter too, not around the pane:
// resizing a pane makes epubjs rebuild every chapter and jump to a position
// of its own. The page colour around the text is the app's (see readerVars).

import { DARK_HIGHLIGHT_FILLS } from './parallel.js'

export const FONT_SIZES = [70, 80, 90, 100, 110, 120, 135, 150, 175, 200] // percent
export const FONTS = {
  book: { label: 'Book', stack: null },
  serif: { label: 'Serif', stack: 'Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, "Times New Roman", serif' },
  sans: { label: 'Sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' },
}
export const LINE_SPACINGS = {
  book: { label: 'Book', value: null },
  compact: { label: 'Compact', value: 1.3 },
  normal: { label: 'Normal', value: 1.6 },
  relaxed: { label: 'Relaxed', value: 1.9 },
}
// Total space either side of the text; PANE_PADDING of it is the pane's own.
export const MARGINS = {
  narrow: { label: 'Narrow', px: 8 },
  normal: { label: 'Normal', px: 24 },
  wide: { label: 'Wide', px: 64 },
}
const PANE_PADDING = 8
// bg/fg: page and text; link: link text; ui: the app's chrome around the book.
export const THEMES = {
  light: { label: 'Light', bg: '#ffffff', fg: '#000000', link: null },
  sepia: { label: 'Sepia', bg: '#f4ecd8', fg: '#4a3b2a', link: '#7a4b12' },
  dark: { label: 'Dark', bg: '#1b1b1d', fg: '#dcdcdc', link: '#8ab4f8' },
}

export const DEFAULT_SETTINGS = { fontSize: 100, font: 'book', lineSpacing: 'book', margins: 'normal', theme: 'light' }

const STORAGE_KEY = 'verbatim.readingSettings'

// Saved settings, or the defaults. Unknown or damaged values fall back one by
// one, so a setting added later never breaks what was saved before.
export function loadSettings() {
  let saved = {}
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}
  } catch {
    saved = {}
  }
  return normalizeSettings(saved)
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* private window or storage full: settings just aren't remembered */
  }
}

export function normalizeSettings(s) {
  const pick = (value, table, fallback) => (Object.hasOwn(table, value) ? value : fallback)
  return {
    fontSize: FONT_SIZES.includes(s.fontSize) ? s.fontSize : DEFAULT_SETTINGS.fontSize,
    font: pick(s.font, FONTS, DEFAULT_SETTINGS.font),
    lineSpacing: pick(s.lineSpacing, LINE_SPACINGS, DEFAULT_SETTINGS.lineSpacing),
    margins: pick(s.margins, MARGINS, DEFAULT_SETTINGS.margins),
    theme: pick(s.theme, THEMES, DEFAULT_SETTINGS.theme),
  }
}

// One step bigger (+1) or smaller (-1), staying within FONT_SIZES.
export function stepFontSize(current, dir) {
  const i = FONT_SIZES.indexOf(current)
  const at = i === -1 ? FONT_SIZES.indexOf(100) : i
  return FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, at + dir))]
}

// The stylesheet put into every chapter for these settings.
export function readerCss(settings) {
  const s = normalizeSettings(settings)
  const rules = []
  const inset = Math.max(0, MARGINS[s.margins].px - PANE_PADDING)
  rules.push(`body { padding-left: ${inset}px !important; padding-right: ${inset}px !important; box-sizing: border-box !important; }`)
  if (s.fontSize !== 100) rules.push(`body { font-size: ${s.fontSize}% !important; }`)
  const font = FONTS[s.font].stack
  if (font) rules.push(`body, body *:not(pre):not(code):not(kbd):not(samp) { font-family: ${font} !important; }`)
  const spacing = LINE_SPACINGS[s.lineSpacing].value
  if (spacing) rules.push(`body, body * { line-height: ${spacing} !important; }`)
  const theme = THEMES[s.theme]
  if (s.theme !== 'light') {
    rules.push(`html, body { background: ${theme.bg} !important; color: ${theme.fg} !important; }`)
    // Books set their own colours (grey captions, coloured headings, white
    // table cells); on a tinted page those must follow the theme.
    rules.push(`body *:not(a) { color: inherit !important; background-color: transparent !important; border-color: currentColor !important; }`)
    rules.push(`a, a * { color: ${theme.link} !important; }`)
  }
  if (s.theme === 'dark') {
    // The selection / counterpart / hover fills are tuned for a white page.
    for (const [name, fill] of Object.entries(DARK_HIGHLIGHT_FILLS)) {
      rules.push(`::highlight(${name}) { background-color: ${fill} !important; }`)
    }
    rules.push(`img { filter: brightness(0.9); }`)
  }
  return rules.join('\n')
}

const STYLE_ID = 'verbatim-reading-settings'

// Apply settings to one chapter document (idempotent).
export function applyToDocument(doc, settings) {
  if (!doc || !doc.head) return
  let style = doc.getElementById(STYLE_ID)
  if (!style) {
    style = doc.createElement('style')
    style.id = STYLE_ID
  }
  // Last in <head>, so equal-strength rules from the book lose.
  doc.head.appendChild(style)
  style.textContent = readerCss(settings)
}

// CSS variables for the app's layout around the book (pane padding, page
// colour), to put on the reader's outer element.
export function readerVars(settings) {
  const s = normalizeSettings(settings)
  const theme = THEMES[s.theme]
  return {
    '--pane-margin': `${PANE_PADDING}px`,
    '--reader-bg': theme.bg,
    '--reader-fg': theme.fg,
  }
}

// Changing the text size or spacing re-flows every chapter, which would move
// the reader somewhere else in the book. Keep the paragraph at the top of the
// pane where it was: note it, run `change`, then keep scrolling it back to the
// same spot while the chapters finish re-laying out.
//
// A margin change resizes the pane, and epubjs answers a resize by jumping to
// the position it last recorded, a few hundred milliseconds later. So the
// correction keeps running for at least KEEP_MIN_MS, and stops at once if the
// reader scrolls, clicks or types in the pane.
const KEEP_MIN_MS = 1500
const KEEP_MAX_MS = 4000
const active = new WeakMap() // scroller -> stop() of the correction running there

export function keepPlace(pane, change) {
  const scroller = pane && (pane.querySelector('.epub-container') || pane)
  active.get(scroller)?.() // a newer change replaces an older correction
  const anchor = scroller && topBlock(scroller)
  change()
  if (!anchor) return

  const offset = () =>
    anchor.el.getBoundingClientRect().top + anchor.frame.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const started = performance.now()
  let stable = 0
  let raf = 0
  const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown']
  const stop = () => {
    cancelAnimationFrame(raf)
    for (const type of inputs) pane.removeEventListener(type, stop, true)
    if (active.get(scroller) === stop) active.delete(scroller)
  }
  for (const type of inputs) pane.addEventListener(type, stop, true)
  active.set(scroller, stop)

  const step = () => {
    if (!anchor.el.isConnected) return stop()
    const delta = offset() - anchor.offset
    if (Math.abs(delta) > 1) {
      scroller.scrollTop += delta
      stable = 0
    } else {
      stable++
    }
    const elapsed = performance.now() - started
    if (elapsed > KEEP_MAX_MS || (elapsed > KEEP_MIN_MS && stable >= 12)) return stop()
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}

// The text block at the top of a pane's view, and its distance from the top.
function topBlock(scroller) {
  const top = scroller.getBoundingClientRect().top + 8
  for (const frame of scroller.querySelectorAll('iframe')) {
    const box = frame.getBoundingClientRect()
    if (box.bottom <= top || box.top > top) continue
    const doc = frame.contentDocument
    if (!doc) return null
    const x = Math.max(4, Math.min(box.width - 4, box.width / 2))
    let el = doc.elementFromPoint(x, top - box.top)
    // Climb to a block-level element: inline runs move as the text re-wraps.
    while (el && el.parentElement && el !== doc.body && getComputedStyleSafe(doc, el).display.startsWith('inline')) el = el.parentElement
    if (!el || el === doc.body || el === doc.documentElement) return null
    return { el, frame, offset: el.getBoundingClientRect().top + box.top - scroller.getBoundingClientRect().top }
  }
  return null
}

function getComputedStyleSafe(doc, el) {
  try {
    return doc.defaultView.getComputedStyle(el)
  } catch {
    return { display: 'block' }
  }
}

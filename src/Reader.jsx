import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import ePub from 'epubjs'
import { loadSections } from './chapters.js'
import { alignSections, alignTexts, firstMatchedPairs } from './align.js'
import { createCrossHighlighter, createLinker, GC_UNDERLINE, SCAN_UNDERLINE } from './parallel.js'
import { scanLevel } from './scan.js'
import ScanPanel from './ScanPanel.jsx'
import RatingPopup from './RatingPopup.jsx'
import ReadingMenu from './ReadingMenu.jsx'
import { applyToDocument, keepPlace, loadSettings, readerVars, saveSettings } from './readingSettings.js'
import { counterpartPlace, placeOfEntry, scrollToEntry, scrollToPlace, trackPlace } from './position.js'
import ContentsDrawer from './ContentsDrawer.jsx'

// Pre-select the first matched section with real body text on both sides, so
// the panel opens on the first chapter rather than a title page.
const MIN_DEFAULT_LENGTH = 2000
function defaultSection(pairs) {
  const i = pairs.findIndex(
    (p) => p.sourceText.length >= MIN_DEFAULT_LENGTH && p.targetText.length >= MIN_DEFAULT_LENGTH,
  )
  return i === -1 ? 0 : i
}

// epubjs's continuous manager lazy-loads: it only renders the sections near the
// viewport and appends/trims more as you scroll. Its `offset` setting is the
// pixel margin it keeps rendered around the viewport — both for deciding when to
// append the next section (manager.check) and for deciding which sections stay
// mounted (manager.update / isVisible). Setting it enormous makes it render the
// ENTIRE book up front and never trim it, so the whole thing is immediately
// scrollable (and fully present for cross-book highlighting) at the cost of a
// longer initial load. Large but finite — Infinity would poison the arithmetic.
const FULL_BOOK_OFFSET = 1e9

// Many Project Gutenberg books ship "a:hover { color: red }". They wrap whole
// paragraphs in <a id="…"> anchors, so moving the mouse over the text turned
// entire paragraphs red. Hovering is how this reader shows its own
// underlines, so the book's hover styles are removed: every rule whose selector
// uses :hover, from each stylesheet as it loads. Links look as they always did.
function removeHoverStyles(doc) {
  if (!doc) return
  const strip = (sheet) => {
    let rules
    try {
      rules = sheet.cssRules
    } catch {
      return // not readable (another origin); epubjs serves books from blob: URLs, so this is rare
    }
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i]
      if (rule.cssRules && !rule.selectorText) strip(rule) // @media blocks
      else if (rule.selectorText && rule.selectorText.includes(':hover')) sheet.deleteRule(i)
    }
  }
  const stripAll = () => {
    for (const sheet of doc.styleSheets) strip(sheet)
  }
  stripAll()
  // Stylesheets still loading (an existing link.sheet may still be empty) are
  // handled again when each one, and the whole chapter, finishes loading.
  for (const link of doc.querySelectorAll('link[rel~="stylesheet"]')) {
    link.addEventListener('load', stripAll, { once: true })
  }
  doc.defaultView?.addEventListener('load', stripAll, { once: true })
}

// Reading settings (readingSettings.js) shared by every open book, remembered
// in this browser. Returns [settings, setSettings].
function useReadingSettings() {
  const [settings, setSettings] = useState(loadSettings)
  useEffect(() => saveSettings(settings), [settings])
  return [settings, setSettings]
}

// Each pane's contents list and current entry, for the contents drawer.
// onContents / onProgress are EpubPane's callbacks; books(sides, fallbackNames)
// gives ContentsDrawer's `books` for the panes shown.
function useContents() {
  const [contents, setContents] = useState({})
  const [current, setCurrent] = useState({})
  const onContents = useCallback((side, info) => setContents((c) => ({ ...c, [side]: info })), [])
  const onProgress = useCallback(
    (side, info) => setCurrent((c) => (c[side] === info.entry ? c : { ...c, [side]: info.entry })),
    [],
  )
  const books = (sides, names) =>
    sides.map((side) => {
      const info = contents[side]
      const lang = info && info.language ? ` (${info.language})` : ''
      return {
        side,
        name: info && info.title ? `${info.title}${lang}` : names[side],
        entries: info ? info.entries : null,
        current: current[side] ?? -1,
      }
    })
  return { books, onContents, onProgress }
}

// Renders one epub into its own scroll box. When `watchResize` is set, it
// reflows as the box width changes (used by the single-book zoom view).
// `onRendition` receives the epubjs rendition once created (null on teardown).
// `settings` (readingSettings.js) are applied to every chapter, keeping the
// reader's place when they change. With a `bookId`, the pane reopens where
// that book (`side`: 'src' or 'tgt') was last left and shows how far
// through it the reader is; `onContents` / `onProgress` pass the book's
// contents list and the current place up (see trackPlace in position.js).
function EpubPane({ url, className, watchResize, onRendition, settings, bookId = null, side = 'src', onContents, onProgress }) {
  const ref = useRef(null)
  const renditionRef = useRef(null)
  const onRenditionRef = useRef(onRendition)
  useEffect(() => {
    onRenditionRef.current = onRendition
  }, [onRendition])
  const [progress, setProgress] = useState(null)
  const callbacks = useRef({ onContents, onProgress })
  useEffect(() => {
    callbacks.current = { onContents, onProgress }
  }, [onContents, onProgress])
  // Read by the chapter hook, so chapters rendered later get the latest settings.
  const settingsRef = useRef(settings)

  useEffect(() => {
    settingsRef.current = settings
    const rendition = renditionRef.current
    if (!rendition) return
    const contents = rendition.getContents()
    if (contents.length === 0) return
    keepPlace(ref.current, () => {
      for (const c of contents) applyToDocument(c.document, settings)
    })
  }, [settings])

  useEffect(() => {
    if (!ref.current) return

    const el = ref.current
    const epub = ePub(url, { openAs: 'epub' })
    const rendition = epub.renderTo(el, {
      width: '100%',
      height: '100%',
      flow: 'scrolled-doc',
      manager: 'continuous',
      offset: FULL_BOOK_OFFSET, // render the whole book up front, no lazy scroll-loading
    })
    rendition.hooks.content.register((contents) => {
      removeHoverStyles(contents.document)
      if (settingsRef.current) applyToDocument(contents.document, settingsRef.current)
    })
    renditionRef.current = rendition
    onRenditionRef.current?.(rendition)
    const stopTracking = trackPlace(rendition, {
      bookId,
      side,
      onContents: (info) => callbacks.current.onContents?.(side, info),
      onProgress: (info) => {
        setProgress(info)
        callbacks.current.onProgress?.(side, info)
      },
    })
    rendition.display()

    // (With FULL_BOOK_OFFSET every section is rendered up front, so the old
    // scroll-triggered manager.check() workaround for lazy-load jumps is no
    // longer needed — and dropping it avoids check/update churn while scrolling.)

    let observer = null
    let rafId = null
    if (watchResize) {
      observer = new ResizeObserver(() => {
        if (rafId) cancelAnimationFrame(rafId)
        rafId = requestAnimationFrame(() => {
          try {
            rendition.resize()
          } catch {
            /* rendition torn down mid-frame */
          }
        })
      })
      observer.observe(el)
    }

    return () => {
      stopTracking()
      observer?.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
      renditionRef.current = null
      onRenditionRef.current?.(null)
      rendition.destroy()
      epub.destroy()
    }
  }, [url, watchResize, bookId, side])

  // The progress line sits in the pane's bottom margin. (epubjs appends its
  // own scroll box to the same element, after this one.)
  return (
    <div className={className} ref={ref}>
      {bookId && progress && <PaneProgress {...progress} />}
    </div>
  )
}

// "Chapter V. … · 34%" with a thin bar, at the foot of a pane.
function PaneProgress({ percent, label }) {
  return (
    <div className="pane-progress" aria-label={`${percent}% read`}>
      <div className="pane-progress-text">
        {label && <span className="pane-progress-label">{label}</span>}
        <span className="pane-progress-percent">{percent}%</span>
      </div>
      <div className="pane-progress-bar">
        <div style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

// Opens both books and aligns them in two Gale–Church passes: first the
// books' sections (split at heading elements) by length, then the sentences
// inside the selected pair of sections. The first 3 matched sentence pairs are
// highlighted in matching colours so the pairing can be verified by eye.
// Nothing here reads chapter titles or numbers, so any language works.
// Read both books and align their sections. Returns { sections, error };
// `sections` is null until ready.
function useParallelBooks(originalUrl, translationUrl) {
  const [state, setState] = useState({ key: null, sections: null, error: '' })
  const key = `${originalUrl}|${translationUrl}`

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [orig, trans] = await Promise.all([
          loadSections(originalUrl),
          loadSections(translationUrl),
        ])
        if (cancelled) return
        const matched = alignSections(orig, trans)
        setState(
          matched.length === 0
            ? { key, sections: null, error: 'Could not match any sections between the two books.' }
            : { key, sections: matched, error: '' },
        )
      } catch (err) {
        if (!cancelled) setState({ key, sections: null, error: String(err?.message || err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, originalUrl, translationUrl])

  // Ignore results that belong to a previous pair of books.
  return state.key === key ? state : { sections: null, error: '' }
}

function AlignmentPanel({ sections, loadError, onClose }) {
  const [selected, setSelected] = useState(() => (sections ? defaultSection(sections) : 0))

  // Sentence-align the selected pair of sections (fast: capped at 200 each).
  const pairs = useMemo(() => {
    const section = sections?.[selected]
    if (!section) return []
    const result = alignTexts(section.sourceText, section.targetText, { limit: 200 })
    return firstMatchedPairs(result, 3)
  }, [sections, selected])

  const ready = sections !== null
  let message = loadError
  if (!message && ready && pairs.length === 0) {
    message = 'No matching sentences found in this section.'
  }

  return (
    <div className="align-backdrop" onClick={onClose}>
      <div className="align-panel" onClick={(e) => e.stopPropagation()}>
        <div className="align-head">
          {ready ? (
            <select
              className="align-select"
              value={selected}
              onChange={(e) => setSelected(Number(e.target.value))}
            >
              {sections.map((s, i) => (
                <option key={i} value={i}>
                  {s.title}
                </option>
              ))}
            </select>
          ) : (
            !loadError && <span>Aligning books…</span>
          )}
          <button className="align-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {message && <p className="align-msg">{message}</p>}

        {pairs.length > 0 && (
          <div className="align-grid">
            <div className="align-colhead">Original</div>
            <div className="align-colhead">Translation</div>
            {pairs.map((pair, i) => (
              <Pair key={i} index={i + 1} pair={pair} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Pair({ index, pair }) {
  return (
    <>
      <div className={`align-cell hl${index}`}>
        <span className="align-num">{index}</span>
        {pair.source.join(' ')}
      </div>
      <div className={`align-cell hl${index}`}>
        <span className="align-num">{index}</span>
        {pair.target.join(' ')}
      </div>
    </>
  )
}

// Side-by-side reader. Selecting text in either book highlights it (amber)
// and highlights the aligned passage in the other book (blue), scrolling the
// other book to it. See parallel.js.
function CompareReader({ book }) {
  const [showAlign, setShowAlign] = useState(false)
  const [showScan, setShowScan] = useState(false)
  // Parallel view on: both books side by side. Off: only the English book
  // (both stay mounted so cross-highlighting keeps working; one is just hidden).
  const [parallel, setParallel] = useState(true)
  const [reading, setReading] = useReadingSettings()
  const [status, setStatus] = useState('')
  // The passage popup: from a selection (onLink) or a click on a flagged,
  // underlined passage (onIssue, which adds scanKey/scanLevel).
  const [linked, setLinked] = useState(null)
  const { sections, error } = useParallelBooks(book.url, book.translationUrl)
  const linker = useMemo(() => (sections ? createLinker(sections) : null), [sections])

  const [highlighter] = useState(() =>
    createCrossHighlighter({
      onStatus: setStatus,
      onLink: (match) => setLinked(match && { ...match, id: Date.now() }),
      onIssue: (issue) => setLinked(issue && { ...issue, id: Date.now() }),
    }),
  )
  const closePopup = useCallback(() => setLinked(null), [])
  useEffect(() => {
    highlighter.setLinker(linker)
  }, [highlighter, linker])

  // Gale–Church heat map: tints the sentences the aligner finds suspicious.
  const [heat, setHeat] = useState(false)
  useEffect(() => {
    highlighter.setHeat(heat)
  }, [highlighter, heat])

  // ChatGPT whole-book scan: results saved so far (on the dev server), and a
  // second heat map showing the passages it scored low.
  const [scan, setScan] = useState({ model: '', results: {} })
  useEffect(() => {
    let alive = true
    fetch(`/api/scan?book=${encodeURIComponent(book.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => alive && data && setScan({ model: data.model, results: data.results || {} }))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [book.id])
  const addScanResults = useCallback(
    (fresh) => setScan((s) => ({ ...s, results: { ...s.results, ...fresh } })),
    [],
  )
  const scanCount = Object.keys(scan.results).length
  const [scanView, setScanView] = useState(false)
  useEffect(() => {
    highlighter.setScanView(scanView, (_bead, info) => scanLevel(scan.results[info.key]))
  }, [highlighter, scanView, scan.results])

  // Status messages fade after a few seconds.
  useEffect(() => {
    if (!status) return
    const t = setTimeout(() => setStatus(''), 3000)
    return () => clearTimeout(t)
  }, [status])

  // Each pane's rendition, for jumping from the contents drawer.
  const renditions = useRef({ src: null, tgt: null })
  const attachSource = useCallback(
    (r) => {
      renditions.current.src = r
      highlighter.attach('src', r)
    },
    [highlighter],
  )
  const attachTarget = useCallback(
    (r) => {
      renditions.current.tgt = r
      highlighter.attach('tgt', r)
    },
    [highlighter],
  )

  // Contents drawer: each book's contents and the entry being read in it.
  const [showContents, setShowContents] = useState(false)
  const { books: contentsBooks, onContents, onProgress } = useContents()
  const shownSides = parallel ? ['src', 'tgt'] : [book.englishSide === 'translation' ? 'tgt' : 'src']
  // Jump one book to a chapter and the other to the matching place.
  const jumpTo = useCallback(
    (side, entry) => {
      const own = renditions.current[side]
      if (!own) return
      setShowContents(false)
      scrollToEntry(own, entry)
      const other = renditions.current[side === 'src' ? 'tgt' : 'src']
      const match = other && counterpartPlace(linker, side, placeOfEntry(own, entry), own)
      if (match) scrollToPlace(other, match)
    },
    [linker],
  )

  let note = status
  if (!note && !sections && !error) note = 'Linking the two books…'
  if (!note && error) note = error

  return (
    <div className={`reader-compare theme-${reading.theme}`} style={readerVars(reading)}>
      <div className="compare-toolbar">
        <ReadingMenu settings={reading} onChange={setReading} />
        <button className="align-button" onClick={() => setShowContents(true)} title="Table of contents">
          Contents
        </button>
        <button
          className={`align-button${parallel ? ' active' : ''}`}
          onClick={() => setParallel((on) => !on)}
          aria-pressed={parallel}
          title="Show both books side by side, or only the English book"
        >
          Parallel view
        </button>
        <button className="align-button" onClick={() => setShowAlign(true)}>
          Align
        </button>
        <button
          className={`align-button${heat ? ' active' : ''}`}
          onClick={() => setHeat((on) => !on)}
          aria-pressed={heat}
          title="Underline the sentences Gale–Church finds suspicious — hover and click one to see why"
        >
          Gale–Church view
        </button>
        <button className="align-button" onClick={() => setShowScan(true)} disabled={!linker}>
          ChatGPT scan
        </button>
        <button
          className={`align-button${scanView ? ' active' : ''}`}
          onClick={() => setScanView((on) => !on)}
          aria-pressed={scanView}
          disabled={scanCount === 0}
          title={scanCount ? 'Underline the passages ChatGPT scored low — hover and click one to see why' : 'Run a ChatGPT scan first'}
        >
          ChatGPT view
        </button>
      </div>
      {note && <div className="compare-status">{note}</div>}
      {(heat || scanView) && <HeatLegend gc={heat} scan={scanView} />}
      <EpubPane
        className={`epub-pane${!parallel && book.englishSide === 'translation' ? ' pane-hidden' : ''}`}
        url={book.url}
        watchResize
        onRendition={attachSource}
        settings={reading}
        bookId={book.id}
        side="src"
        onContents={onContents}
        onProgress={onProgress}
      />
      <EpubPane
        className={`epub-pane${!parallel && book.englishSide !== 'translation' ? ' pane-hidden' : ''}`}
        url={book.translationUrl}
        watchResize
        onRendition={attachTarget}
        settings={reading}
        bookId={book.id}
        side="tgt"
        onContents={onContents}
        onProgress={onProgress}
      />
      {showContents && (
        <ContentsDrawer
          books={contentsBooks(shownSides, { src: 'Original', tgt: 'Translation' })}
          onPick={jumpTo}
          onClose={() => setShowContents(false)}
        />
      )}
      {linked && (
        <RatingPopup
          key={linked.id}
          original={linked.original}
          translation={linked.translation}
          anchor={linked.anchor}
          gc={linked.gc}
          scan={
            linked.scanLevel
              ? { level: linked.scanLevel, ...(scan.results[linked.scanKey] || {}) }
              : null
          }
          onClose={closePopup}
        />
      )}
      {showAlign && (
        <AlignmentPanel
          key={sections ? 'ready' : 'loading'}
          sections={sections}
          loadError={error}
          onClose={() => setShowAlign(false)}
        />
      )}
      {showScan && linker && (
        <ScanPanel
          linker={linker}
          book={book.id}
          scan={scan}
          onResults={addScanResults}
          onFocus={(pair) => {
            setShowScan(false)
            highlighter.focus(pair)
          }}
          onClose={() => setShowScan(false)}
        />
      )}
    </div>
  )
}

// Key for the heat maps. Colours come from parallel.js so they always match.
const HEAT_LABELS = {
  unmatched: 'No counterpart (omitted or added)',
  mismatch: 'Length mismatch (p < 1%)',
  loose: 'Unusual length (p < 5%)',
}
const SCAN_LABELS = {
  not_matching: 'ChatGPT: not a translation of each other',
  bad: 'ChatGPT: score 1–3',
  weak: 'ChatGPT: score 4–5',
}
function HeatLegend({ gc, scan }) {
  const items = [
    ...(gc ? Object.entries(HEAT_LABELS).map(([level, label]) => [label, GC_UNDERLINE[level][0]]) : []),
    ...(scan ? Object.entries(SCAN_LABELS).map(([level, label]) => [label, SCAN_UNDERLINE[level][0]]) : []),
  ]
  return (
    <div className="heat-legend">
      {items.map(([label, color]) => (
        <span key={label} className="heat-item">
          <span className="heat-swatch" style={{ borderBottom: `3px solid ${color}` }} />
          {label}
        </span>
      ))}
    </div>
  )
}

function Reader({ books }) {
  const { id } = useParams()
  const book = books.find((b) => b.id === id)

  if (!book) {
    return <main className="page">Book not found.</main>
  }

  // Original + translation: compare side by side with alignment checking.
  if (book.url && book.translationUrl) {
    return <CompareReader book={book} />
  }

  // Single book: existing zoomable view.
  return <SingleReader book={book} />
}

// One book on its own, with the same reading settings as the parallel view.
function SingleReader({ book }) {
  const [reading, setReading] = useReadingSettings()
  const rendition = useRef(null)
  const [showContents, setShowContents] = useState(false)
  const { books: contentsBooks, onContents, onProgress } = useContents()
  return (
    <div className={`reader-single theme-${reading.theme}`} style={readerVars(reading)}>
      <div className="single-toolbar">
        <button className="align-button" onClick={() => setShowContents(true)} title="Table of contents">
          Contents
        </button>
        <ReadingMenu settings={reading} onChange={setReading} />
      </div>
      <EpubPane
        className="reader-box"
        url={book.url}
        watchResize
        settings={reading}
        onRendition={(r) => (rendition.current = r)}
        bookId={book.id}
        side="src"
        onContents={onContents}
        onProgress={onProgress}
      />
      {showContents && (
        <ContentsDrawer
          books={contentsBooks(['src'], { src: 'Book' })}
          onPick={(_side, entry) => {
            setShowContents(false)
            if (rendition.current) scrollToEntry(rendition.current, entry)
          }}
          onClose={() => setShowContents(false)}
        />
      )}
    </div>
  )
}

export default Reader

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import ePub from 'epubjs'
import { loadSections } from './chapters.js'
import { alignSections, alignTexts, firstMatchedPairs } from './align.js'
import { createCrossHighlighter, createLinker } from './parallel.js'
import RatingPopup from './RatingPopup.jsx'

// Pre-select the first matched section with real body text on both sides, so
// the panel opens on the first chapter rather than a title page.
const MIN_DEFAULT_LENGTH = 2000
function defaultSection(pairs) {
  const i = pairs.findIndex(
    (p) => p.sourceText.length >= MIN_DEFAULT_LENGTH && p.targetText.length >= MIN_DEFAULT_LENGTH,
  )
  return i === -1 ? 0 : i
}

// Renders one epub into its own scroll box. When `watchResize` is set, it
// reflows as the box width changes (used by the single-book zoom view).
// `onRendition` receives the epubjs rendition once created (null on teardown).
function EpubPane({ url, className, watchResize, onRendition }) {
  const ref = useRef(null)
  const onRenditionRef = useRef(onRendition)
  useEffect(() => {
    onRenditionRef.current = onRendition
  }, [onRendition])

  useEffect(() => {
    if (!ref.current) return

    const el = ref.current
    const epub = ePub(url, { openAs: 'epub' })
    const rendition = epub.renderTo(el, {
      width: '100%',
      height: '100%',
      flow: 'scrolled-doc',
      manager: 'continuous',
    })
    onRenditionRef.current?.(rendition)
    rendition.display()

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
      observer?.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
      onRenditionRef.current?.(null)
      rendition.destroy()
      epub.destroy()
    }
  }, [url, watchResize])

  return <div className={className} ref={ref} />
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
  const [status, setStatus] = useState('')
  const [linked, setLinked] = useState(null) // { id, original, translation, anchor }
  const { sections, error } = useParallelBooks(book.url, book.translationUrl)

  const [highlighter] = useState(() =>
    createCrossHighlighter({
      onStatus: setStatus,
      onLink: (match) => setLinked(match && { ...match, id: Date.now() }),
    }),
  )
  const closePopup = useCallback(() => setLinked(null), [])
  useEffect(() => {
    highlighter.setLinker(sections ? createLinker(sections) : null)
  }, [highlighter, sections])

  // Status messages fade after a few seconds.
  useEffect(() => {
    if (!status) return
    const t = setTimeout(() => setStatus(''), 3000)
    return () => clearTimeout(t)
  }, [status])

  const attachSource = useCallback((r) => highlighter.attach('src', r), [highlighter])
  const attachTarget = useCallback((r) => highlighter.attach('tgt', r), [highlighter])

  let note = status
  if (!note && !sections && !error) note = 'Linking the two books…'
  if (!note && error) note = error

  return (
    <div className="reader-compare">
      <button className="align-button" onClick={() => setShowAlign(true)}>
        Align
      </button>
      {note && <div className="compare-status">{note}</div>}
      <EpubPane className="epub-pane" url={book.url} onRendition={attachSource} />
      <EpubPane className="epub-pane" url={book.translationUrl} onRendition={attachTarget} />
      {linked && (
        <RatingPopup
          key={linked.id}
          original={linked.original}
          translation={linked.translation}
          anchor={linked.anchor}
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
  return <EpubPane className="reader-box" url={book.url} watchResize />
}

export default Reader

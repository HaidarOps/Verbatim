import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import ePub from 'epubjs'
import { loadSections } from './chapters.js'
import { alignSections, alignTexts, firstMatchedPairs } from './align.js'

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
function EpubPane({ url, className, watchResize }) {
  const ref = useRef(null)

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
function AlignmentPanel({ originalUrl, translationUrl, onClose }) {
  const [sections, setSections] = useState(null) // matched section pairs
  const [selected, setSelected] = useState(0)
  const [loadError, setLoadError] = useState('')

  // Read both books and align their sections once.
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
        if (matched.length === 0) {
          setLoadError('Could not match any sections between the two books.')
          return
        }
        setSections(matched)
        setSelected(defaultSection(matched))
      } catch (err) {
        if (!cancelled) setLoadError(String(err?.message || err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [originalUrl, translationUrl])

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

function CompareReader({ book }) {
  const [showAlign, setShowAlign] = useState(false)

  return (
    <div className="reader-compare">
      <button className="align-button" onClick={() => setShowAlign(true)}>
        Align
      </button>
      <EpubPane className="epub-pane" url={book.url} />
      <EpubPane className="epub-pane" url={book.translationUrl} />
      {showAlign && (
        <AlignmentPanel
          originalUrl={book.url}
          translationUrl={book.translationUrl}
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

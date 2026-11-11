import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import ePub from 'epubjs'
import { openAlignBook, extractChapterText } from './chapters.js'
import { alignTexts, firstMatchedPairs } from './align.js'

// Chapter to select by default: III. "The Second Marriage and the Second Family".
const DEFAULT_CHAPTER = 2

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

// Opens both books, lists their chapters, and for the selected chapter aligns
// the two editions and shows the first 3 matched segments highlighted in
// matching colours so the pairing can be verified by eye. Chapters are matched
// by ordinal, so the Nth chapter of the original lines up with the Nth of the
// translation even when their front matter differs.
function AlignmentPanel({ originalUrl, translationUrl, onClose }) {
  const [ready, setReady] = useState(false)
  const [chapters, setChapters] = useState([])
  const [selected, setSelected] = useState(DEFAULT_CHAPTER)
  const [phase, setPhase] = useState('loading') // loading | aligning | done | error
  const [pairs, setPairs] = useState([])
  const [message, setMessage] = useState('')
  const booksRef = useRef(null)

  // Open both books and read their chapter lists once.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [orig, trans] = await Promise.all([
          openAlignBook(originalUrl),
          openAlignBook(translationUrl),
        ])
        if (cancelled) {
          orig.book.destroy()
          trans.book.destroy()
          return
        }
        booksRef.current = { orig, trans }
        setChapters(orig.chapters.map((c) => c.label))
        setSelected(Math.min(DEFAULT_CHAPTER, Math.max(0, orig.chapters.length - 1)))
        setReady(true)
      } catch (err) {
        if (!cancelled) {
          setMessage(String(err?.message || err))
          setPhase('error')
        }
      }
    })()
    return () => {
      cancelled = true
      const b = booksRef.current
      if (b) {
        b.orig.book.destroy()
        b.trans.book.destroy()
      }
    }
  }, [originalUrl, translationUrl])

  // Align the selected chapter.
  useEffect(() => {
    if (!ready) return
    const b = booksRef.current
    if (!b) return
    let cancelled = false
    setPhase('aligning')
    ;(async () => {
      try {
        const [srcText, tgtText] = await Promise.all([
          extractChapterText(b.orig.book, b.orig.chapters, selected),
          extractChapterText(b.trans.book, b.trans.chapters, selected),
        ])
        if (cancelled) return
        const result = alignTexts(srcText, tgtText, { limit: 200 })
        const matched = firstMatchedPairs(result, 3)
        if (cancelled) return
        if (matched.length === 0) {
          setMessage('No matching sentences found in this chapter.')
          setPhase('error')
        } else {
          setPairs(matched)
          setPhase('done')
        }
      } catch (err) {
        if (!cancelled) {
          setMessage(String(err?.message || err))
          setPhase('error')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ready, selected])

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
              {chapters.map((title, i) => (
                <option key={i} value={i}>
                  {title}
                </option>
              ))}
            </select>
          ) : (
            <span>Loading chapters…</span>
          )}
          <button className="align-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {phase === 'aligning' && <p className="align-msg">Aligning…</p>}
        {phase === 'error' && <p className="align-msg">{message}</p>}

        {phase === 'done' && (
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

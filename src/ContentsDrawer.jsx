import { useEffect, useRef, useState } from 'react'

// Side drawer listing a book's own table of contents. `books` is
// [{ side, name, entries, current }] (entries from tableOfContents in
// position.js, current = index of the entry being read, or -1); with two
// books, tabs switch between them. `onPick(side, entry)` jumps there.
export default function ContentsDrawer({ books, onPick, onClose }) {
  const [tab, setTab] = useState(books[0]?.side)
  const book = books.find((b) => b.side === tab) || books[0]
  const list = useRef(null)

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Open on the chapter being read.
  useEffect(() => {
    const el = list.current && list.current.querySelector('.contents-entry.current')
    if (el) el.scrollIntoView({ block: 'center' })
  }, [tab])

  return (
    <div className="contents-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <nav className="contents-drawer" aria-label="Contents">
        <div className="contents-head">
          <span className="contents-title">Contents</span>
          <button className="contents-close" onClick={onClose} aria-label="Close contents">
            ×
          </button>
        </div>
        {books.length > 1 && (
          <div className="contents-tabs" role="tablist">
            {books.map((b) => (
              <button
                key={b.side}
                role="tab"
                aria-selected={b.side === book.side}
                className={`contents-tab${b.side === book.side ? ' active' : ''}`}
                onClick={() => setTab(b.side)}
                title={b.name}
              >
                {b.name}
              </button>
            ))}
          </div>
        )}
        <ol className="contents-list" ref={list}>
          {!book || book.entries === null ? (
            <li className="contents-empty">Loading…</li>
          ) : book.entries.length === 0 ? (
            <li className="contents-empty">This book has no table of contents.</li>
          ) : (
            book.entries.map((entry, i) => (
              <li key={`${entry.href}-${i}`}>
                <button
                  className={`contents-entry${i === book.current ? ' current' : ''}`}
                  style={{ paddingLeft: 12 + 14 * Math.min(entry.depth, 4) }}
                  aria-current={i === book.current ? 'location' : undefined}
                  onClick={() => onPick(book.side, entry)}
                >
                  {entry.label}
                </button>
              </li>
            ))
          )}
        </ol>
        {books.length > 1 && <p className="contents-note">The other book follows to the matching place.</p>}
      </nav>
    </div>
  )
}

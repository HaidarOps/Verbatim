import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// "How to get started": a button that opens a short guide in a modal laid over
// everything — the home page or the reader with its book iframes. Used on the
// home page (beside Feedback) and in the reader's toolbar. The modal is
// rendered into <body>: inside the toolbar, which is centred with a CSS
// transform, a position:fixed overlay would be pinned to the toolbar rather
// than the screen.
function GettingStarted({ className = 'align-button', label = 'How to get started' }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && createPortal(
        <div className="guide-backdrop" onClick={() => setOpen(false)}>
          <div
            className="guide-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="guide-close" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
            <h2 id="guide-title">How to get started</h2>
            <ol className="guide-steps">
              <li>
                <strong>Pick a book.</strong> Open one of the pairs on the main page, or bring your own:
                press <em>+ Add ebook</em> for the original, then <em>+ Add translation</em> for its
                translation (both as EPUB files).
              </li>
              <li>
                <strong>Read them side by side.</strong> The original and the translation are lined up
                sentence by sentence. On a phone you start with one book; <em>Parallel view</em> shows
                both.
              </li>
              <li>
                <strong>Select a sentence</strong> in either book (on a phone, press and hold a word). It
                lights up in amber, and the matching sentence in the other book in blue. A popup shows
                both, and <em>Rate this translation</em> asks ChatGPT how faithful it is.
              </li>
              <li>
                <strong>Press Check issues</strong> to scan the whole book for problems. It finds
                passages where the translation leaves out, adds or changes something
                (<span className="guide-red">translation errors</span>) and places where the two books
                don't line up (<span className="guide-purple">alignment errors</span>). The first check of
                a book takes a few minutes; after that it's instant.
              </li>
              <li>
                <strong>Tap a marked passage</strong> to see what's wrong and what the original actually
                says.
              </li>
              <li>
                <strong>Make it comfortable.</strong> <em>Aa</em> changes text size, font, spacing and
                colours; <em>Contents</em> jumps to a chapter. Each book reopens where you left off.
              </li>
            </ol>
            <button type="button" className="rate-button" onClick={() => setOpen(false)}>
              Got it
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

export default GettingStarted

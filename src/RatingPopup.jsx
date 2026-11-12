import { useEffect, useRef, useState } from 'react'

const WIDTH = 380
const MARGIN = 12

// Popup shown next to a highlighted passage. Its button sends the original
// passage and its aligned translation to /api/rate-translation (ChatGPT, via
// the dev server; see server/rateTranslation.js) and shows the 1-10 score and
// the reasons. Mount it with a new `key` per selection to reset it.
function RatingPopup({ original, translation, anchor, gc, onClose }) {
  const [state, setState] = useState({ phase: 'idle' }) // idle | loading | done | error
  const abortRef = useRef(null)

  // Escape closes; a pending request is abandoned when the popup goes away.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      abortRef.current?.abort()
    }
  }, [onClose])

  async function rate() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setState({ phase: 'loading' })
    try {
      const res = await fetch('/api/rate-translation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ original, translation }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`)
      setState({ phase: 'done', rating: data })
    } catch (err) {
      if (err.name === 'AbortError') return
      setState({ phase: 'error', message: err.message || String(err) })
    }
  }

  return (
    <div className="rate-popup" style={placement(anchor)} role="dialog" aria-label="Rate translation">
      <button className="rate-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <div className="rate-passages">
        <p className="rate-passage rate-original">{original}</p>
        <p className="rate-passage rate-translation">{translation}</p>
      </div>

      {gc && <GaleChurchLine gc={gc} />}

      {state.phase === 'idle' && (
        <button className="rate-button" onClick={rate}>
          Rate this translation
        </button>
      )}
      {state.phase === 'loading' && <p className="rate-msg">Asking ChatGPT…</p>}
      {state.phase === 'error' && (
        <>
          <p className="rate-msg rate-error">{state.message}</p>
          <button className="rate-button" onClick={rate}>
            Try again
          </button>
        </>
      )}
      {state.phase === 'done' && <RatingResult rating={state.rating} />}
    </div>
  )
}

// How the length-based aligner saw this passage: sentences matched (e.g.
// "1→2"), how plausible the length ratio is, and its flag, if any.
const GC_VERDICT = {
  unmatched: 'no counterpart',
  mismatch: 'length mismatch',
  loose: 'unusual length',
}
function GaleChurchLine({ gc }) {
  const fit = gc.p === null ? null : gc.p >= 0.1 ? 'lengths fit' : `length fit p ≈ ${formatP(gc.p)}`
  return (
    <p className={`rate-gc${gc.flag ? ` flag-${gc.flag}` : ''}`}>
      Gale–Church: {gc.shapes.join(', ')} sentences
      {fit && ` · ${fit}`}
      {gc.flag && ` · ${GC_VERDICT[gc.flag]}`}
    </p>
  )
}
function formatP(p) {
  if (p < 0.001) return '<0.1%'
  return `${(p * 100).toFixed(p < 0.01 ? 1 : 0)}%`
}

function RatingResult({ rating }) {
  const { score, summary, issues, sourceLanguage, targetLanguage } = rating
  return (
    <div className="rate-result">
      <div className="rate-score-row">
        <span className={`rate-score ${score >= 8 ? 'good' : score >= 5 ? 'ok' : 'bad'}`}>{score}</span>
        <span className="rate-outof">/ 10</span>
        {sourceLanguage && targetLanguage && (
          <span className="rate-langs">
            {sourceLanguage} → {targetLanguage}
          </span>
        )}
      </div>
      {summary && <p className="rate-summary">{summary}</p>}
      {issues.length > 0 && (
        <ul className="rate-issues">
          {issues.map((issue, i) => (
            <li key={i}>
              <div className="rate-words">
                {issue.sourceWords ? <q>{issue.sourceWords}</q> : <em>(nothing)</em>}
                {' → '}
                {issue.targetWords ? <q>{issue.targetWords}</q> : <em>(omitted)</em>}
              </div>
              <div className="rate-problem">{issue.problem}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Below the selection, or above it when it sits low on the screen; kept
// inside the window horizontally.
function placement(anchor) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(WIDTH, vw - 2 * MARGIN)
  if (!anchor) return { width, left: (vw - width) / 2, top: 80 }
  const left = Math.min(Math.max(anchor.left, MARGIN), vw - width - MARGIN)
  if (anchor.bottom < vh * 0.55) {
    return { width, left, top: Math.max(anchor.bottom + 8, MARGIN), maxHeight: vh - anchor.bottom - 8 - MARGIN }
  }
  return { width, left, bottom: vh - anchor.top + 8, maxHeight: anchor.top - 8 - MARGIN }
}

export default RatingPopup

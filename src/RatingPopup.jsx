import { useEffect, useRef, useState } from 'react'

const WIDTH = 380
const MARGIN = 12

// Popup shown next to a highlighted passage. Its button sends the original
// passage and its aligned translation to /api/rate-translation (ChatGPT, via
// the dev server; see server/rateTranslation.js) and shows the 1-10 score and
// the reasons. Mount it with a new `key` per selection to reset it.
function RatingPopup({ original, translation, anchor, gc, scan, issue, onClose }) {
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

      {issue && <IssueLine issue={issue} />}
      {gc && <GaleChurchLine gc={gc} />}
      {scan && <ScanLine scan={scan} />}

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

// Plain-language explanation of the quick length check (Gale–Church): it only
// compares how long each passage is against its translation — translations are
// usually a predictable length, so an odd one is worth a look. It reads no
// meaning, so this is a hint, not a verdict.
const GC_EXPLAIN = {
  unmatched:
    'We couldn’t find a matching passage for this in the other book, so it may have been added or left out in translation.',
  mismatch:
    'This passage is a very different length from its translation. Translations are usually close in length, so a big difference can mean something was added, dropped, or changed.',
  loose:
    'This passage is a slightly unusual length next to its translation — probably fine, but worth a second look.',
}

// A merged or split passage, in plain words (nothing for a plain 1-to-1).
function shapeNote(shapes) {
  if (shapes.length !== 1) return null
  const [s, t] = shapes[0].split('→').map(Number)
  if (!s || !t || s === t) return null
  return s > t
    ? ` Here, ${s} sentences in the original become ${t} in the translation.`
    : ` Here, ${s} sentence${s > 1 ? 's' : ''} in the original ${s > 1 ? 'become' : 'becomes'} ${t} in the translation.`
}

function GaleChurchLine({ gc }) {
  const text = gc.flag
    ? GC_EXPLAIN[gc.flag]
    : 'The two passages are about the length we’d expect, which is a good sign.'
  return (
    <p className={`rate-why rate-gc${gc.flag ? ` flag-${gc.flag}` : ''}`}>
      <strong>Length check:</strong> {text}
      {shapeNote(gc.shapes)}
    </p>
  )
}

// A confirmed issue: a length-check red signal that a strong model read and
// agreed is genuinely bad (issues.js). This is the verdict the "Issues" view
// shows; it was decided ahead of time, so there is nothing to ask ChatGPT now.
const ISSUE_EXPLAIN = {
  alignment:
    'These two passages don’t actually line up — they aren’t translations of each other. The match here is wrong, so compare them with care.',
  translation:
    'ChatGPT read both passages and found a real problem with the translation here — something important was changed, added, or left out.',
}
const ISSUE_TITLE = { alignment: 'Alignment error', translation: 'Translation error' }
function IssueLine({ issue }) {
  const level = issue.level === 'alignment' ? 'alignment' : 'translation'
  return (
    <p className={`rate-why rate-issue level-${level}`}>
      <strong>{ISSUE_TITLE[level]}:</strong> {ISSUE_EXPLAIN[level]}
      {issue.reason ? ` It noted: “${issue.reason}”` : ''}
    </p>
  )
}

// Plain-language version of the ChatGPT scan's stored verdict: unlike the
// length check, ChatGPT actually reads both passages. Shows its verdict, the
// score, and the short reason it gave.
const SCAN_VERDICT = {
  not_matching: 'reading both passages, these don’t look like translations of each other.',
  bad: 'reading both passages, this is a weak translation',
  weak: 'reading both passages, this translation is okay but has problems',
}
function ScanLine({ scan }) {
  const verdict = SCAN_VERDICT[scan.level] || 'reviewed this translation'
  const withScore = scan.level === 'not_matching' ? verdict : `${verdict} (scored ${scan.score ?? '?'} out of 10).`
  return (
    <p className={`rate-why rate-scan level-${scan.level}`}>
      <strong>ChatGPT:</strong> {withScore}
      {scan.issue ? ` It noted: “${scan.issue}”` : ''}
    </p>
  )
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

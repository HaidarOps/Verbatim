import { useEffect, useMemo, useRef, useState } from 'react'
import { compareScan, estimateTokens, runScan, scannable } from './scan.js'

// Aligning a whole book takes a few seconds; do it once per linker.
const beadsByLinker = new WeakMap()
function beadsFor(linker, onProgress) {
  if (!beadsByLinker.has(linker)) beadsByLinker.set(linker, linker.allBeads(onProgress))
  return beadsByLinker.get(linker)
}

const fmt = (n) => (n === null || n === undefined ? '–' : n.toLocaleString())
const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`)
const GC_LABEL = { none: 'Not flagged', loose: 'Unusual length (p < 5%)', mismatch: 'Length mismatch (p < 1%)' }
const KIND_LABEL = { good: 'good', translation_issue: 'translation issue', not_matching: 'not matching' }

// Modal for the whole-book ChatGPT scan: estimate, run (resumable), and the
// report on how Gale–Church's flags line up with ChatGPT's.
function ScanPanel({ linker, book, scan, onResults, onFocus, onClose }) {
  const [beads, setBeads] = useState(null)
  const [prep, setPrep] = useState({ done: 0, total: 0 })
  const [run, setRun] = useState(null) // progress while scanning / after a run
  const abortRef = useRef(null)

  useEffect(() => {
    let alive = true
    beadsFor(linker, (done, total) => alive && setPrep({ done, total })).then((b) => alive && setBeads(b))
    return () => {
      alive = false
    }
  }, [linker])

  // Stop a running scan when the panel closes (finished batches are saved).
  useEffect(() => () => abortRef.current?.abort(), [])

  const results = scan.results
  const items = useMemo(() => (beads ? scannable(beads) : []), [beads])
  const remaining = useMemo(() => items.filter((it) => !results[it.key]), [items, results])
  const estimate = useMemo(() => estimateTokens(remaining), [remaining])
  const report = useMemo(() => (beads ? compareScan(beads, results) : null), [beads, results])
  const running = run && run.running

  async function start() {
    const controller = new AbortController()
    abortRef.current = controller
    setRun({ running: true, done: 0, total: estimate.batches, failed: 0, error: '' })
    const out = await runScan(items, {
      book,
      known: results,
      signal: controller.signal,
      onProgress: (p) => {
        setRun({ running: true, ...p })
        onResults(p.results)
      },
    })
    onResults(out.results)
    setRun({ running: false, ...out, aborted: controller.signal.aborted })
  }

  return (
    <div className="align-backdrop" onClick={onClose}>
      <div className="align-panel scan-panel" onClick={(e) => e.stopPropagation()}>
        <div className="align-head">
          <span>
            ChatGPT scan · <span className="scan-model">{scan.model}</span>
          </span>
          <button className="align-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {!beads && (
          <p className="align-msg">
            Aligning the whole book… {prep.total ? `${prep.done} / ${prep.total} sections` : ''}
          </p>
        )}

        {beads && (
          <div className="scan-body">
            <p>
              {fmt(items.length)} aligned passage pairs ({fmt(beads.length - items.length)} one-sided pairs have
              nothing to compare and are skipped). Scanned so far: <b>{fmt(items.length - remaining.length)}</b>.
            </p>

            {remaining.length > 0 && !running && (
              <div className="scan-start">
                <p>
                  Remaining: {fmt(remaining.length)} pairs in {fmt(estimate.batches)} requests, roughly{' '}
                  {fmt(estimate.input)} input + {fmt(estimate.output)} output tokens. Results are saved as they
                  arrive, so you can stop and resume.
                </p>
                <button className="rate-button" onClick={start}>
                  Scan {fmt(remaining.length)} pairs
                </button>
              </div>
            )}

            {run && (
              <div className="scan-progress">
                <div className="scan-bar">
                  <div style={{ width: `${run.total ? (100 * run.done) / run.total : 0}%` }} />
                </div>
                <p>
                  {running ? 'Scanning' : run.aborted ? 'Stopped' : 'Finished'}: {fmt(run.done)} / {fmt(run.total)}{' '}
                  requests
                  {run.failed > 0 && `, ${run.failed} failed`}
                  {run.usage && run.usage.prompt_tokens > 0 &&
                    ` · used ${fmt(run.usage.prompt_tokens)} input + ${fmt(run.usage.completion_tokens)} output tokens`}
                  {running && (
                    <button className="scan-stop" onClick={() => abortRef.current?.abort()}>
                      Stop
                    </button>
                  )}
                </p>
                {run.error && <p className="rate-error">{run.stopped ? 'Stopped after repeated errors: ' : ''}{run.error}</p>}
              </div>
            )}

            {report && report.scanned > 0 && <Report report={report} onFocus={onFocus} />}
          </div>
        )}
      </div>
    </div>
  )
}

function Report({ report, onFocus }) {
  const [tab, setTab] = useState('both')
  const { overlap } = report
  return (
    <div className="scan-report">
      <h3>How the two indicators line up</h3>
      <p>
        Of {fmt(report.scanned)} scanned pairs, Gale–Church flags <b>{fmt(report.gcFlagged)}</b> and ChatGPT flags{' '}
        <b>{fmt(report.scanFlagged)}</b> (score ≤ 5 or not matching). Both flag <b>{fmt(overlap.both)}</b>.
      </p>
      <p>
        When Gale–Church flags a pair, ChatGPT also flags it <b>{pct(report.gcAlsoScan)}</b> of the time
        {report.lift !== null && (
          <>
            {' '}
            — <b>{report.lift.toFixed(1)}×</b> as often as for pairs Gale–Church accepts
          </>
        )}
        . Of ChatGPT&apos;s flags, <b>{pct(report.scanAlsoGc)}</b> were also Gale–Church flags. ChatGPT judged{' '}
        <b>{fmt(report.notMatching)}</b> pairs not to correspond at all (alignment errors).
      </p>

      <table className="scan-table">
        <thead>
          <tr>
            <th>Gale–Church</th>
            <th>Scanned</th>
            <th>ChatGPT flags</th>
            <th>Not matching</th>
            <th>Mean score</th>
          </tr>
        </thead>
        <tbody>
          {report.byGc.map((r) => (
            <tr key={r.level}>
              <td>{GC_LABEL[r.level]}</td>
              <td>
                {fmt(r.scanned)}
                {r.scanned < r.pairs && <span className="scan-dim"> / {fmt(r.pairs)}</span>}
              </td>
              <td>{r.scanned ? `${pct(r.flagged / r.scanned)} (${fmt(r.flagged)})` : '–'}</td>
              <td>{r.scanned ? `${pct(r.notMatching / r.scanned)} (${fmt(r.notMatching)})` : '–'}</td>
              <td>{r.meanScore === null ? '–' : r.meanScore.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="scan-table scan-overlap">
        <thead>
          <tr>
            <th />
            <th>ChatGPT flags</th>
            <th>ChatGPT accepts</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>Gale–Church flags</th>
            <td>{fmt(overlap.both)}</td>
            <td>{fmt(overlap.gcOnly)}</td>
          </tr>
          <tr>
            <th>Gale–Church accepts</th>
            <td>{fmt(overlap.scanOnly)}</td>
            <td>{fmt(overlap.neither)}</td>
          </tr>
        </tbody>
      </table>

      <div className="scan-tabs">
        {[
          ['both', `Both flag (${fmt(overlap.both)})`],
          ['gcOnly', `Only Gale–Church (${fmt(overlap.gcOnly)})`],
          ['scanOnly', `Only ChatGPT (${fmt(overlap.scanOnly)})`],
        ].map(([key, label]) => (
          <button key={key} className={`align-button${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <p className="scan-dim">Click an example to show it in the book.</p>
      <ul className="scan-examples">
        {report.examples[tab].map((ex) => (
          <li key={ex.key} onClick={() => onFocus(ex)}>
            <div className="scan-meta">
              {ex.section && <span>{ex.section.slice(0, 50)}</span>}
              <span>Gale–Church: {ex.gcFlag ? GC_LABEL[ex.gcFlag].toLowerCase() : 'ok'}{ex.gcP !== null && ` (p ≈ ${ex.gcP < 0.001 ? '<0.1%' : pct(ex.gcP)})`}</span>
              <span>
                ChatGPT: {ex.result.score}/10, {KIND_LABEL[ex.result.kind]}
              </span>
            </div>
            <p className="rate-passage rate-original">{ex.original}</p>
            <p className="rate-passage rate-translation">{ex.translation}</p>
            {ex.result.issue && <p className="scan-issue">{ex.result.issue}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default ScanPanel

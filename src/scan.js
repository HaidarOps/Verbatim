// Whole-book ChatGPT scan and its comparison with Gale–Church.
//
// Every bead Gale–Church produced that has text on both sides is sent, in
// batches, to /api/scan (a cheap OpenAI model on the dev server; see
// server/scanTranslations.js), which scores it 1-10 and labels it "good",
// "translation_issue" or "not_matching" (the pair isn't a translation of each
// other: an alignment error). compareScan() then measures how often the two
// indicators flag the same passages.
//
// Pure logic, no DOM: unit-tested in src/scan.test.mjs.

// --- What counts as a ChatGPT flag -----------------------------------------

export const SCAN_FLAG_MAX = 5 // scores at or below this count as a flag

// Heat-map level for a scan result (see SCAN_COLORS in parallel.js).
export function scanLevel(result) {
  if (!result) return null
  if (result.kind === 'not_matching') return 'not_matching'
  if (result.score <= 3) return 'bad'
  if (result.score <= SCAN_FLAG_MAX) return 'weak'
  return null
}
export const isScanFlag = (result) => scanLevel(result) !== null

// --- Batching and running ----------------------------------------------------

const BATCH_PAIRS = 20
const BATCH_CHARS = 10000

// Beads with text on both sides; one-sided beads have nothing to compare.
export const scannable = (beads) => beads.filter((b) => b.original && b.translation)

export function makeBatches(items, { maxPairs = BATCH_PAIRS, maxChars = BATCH_CHARS } = {}) {
  const batches = []
  let cur = []
  let chars = 0
  for (const it of items) {
    const size = it.original.length + it.translation.length
    if (cur.length && (cur.length >= maxPairs || chars + size > maxChars)) {
      batches.push(cur)
      cur = []
      chars = 0
    }
    cur.push(it)
    chars += size
  }
  if (cur.length) batches.push(cur)
  return batches
}

// Rough token count for the remaining work (about 4 characters per token,
// plus the instructions per request and a short answer per pair). For the
// order of magnitude only; the server reports exact usage per batch.
export function estimateTokens(items) {
  const batches = makeBatches(items).length
  const chars = items.reduce((n, it) => n + it.original.length + it.translation.length + 40, 0)
  return { input: Math.round(chars / 4) + batches * 300, output: items.length * 30, batches }
}

// Scan `items` (from scannable()) not yet in `known` results. Calls
// onProgress({ done, total, failed, results, usage, error }) after each batch.
// Stops early on abort, or after 3 failures in a row (e.g. no API key).
// `endpoint` and `mapPair` are overridable so the same batching/concurrency/
// caching drives the strong-model verification of flagged passages too (see
// runVerify in src/issues.js), which posts to /api/verify and carries each
// pair's Gale–Church flag.
const defaultMapPair = ({ key, original, translation }) => ({ key, original, translation })
export async function runScan(items, { book, known = {}, fetchImpl = fetch, concurrency = 3, signal, onProgress, endpoint = '/api/scan', mapPair = defaultMapPair }) {
  const todo = items.filter((it) => !known[it.key])
  const batches = makeBatches(todo)
  const results = {}
  const usage = { prompt_tokens: 0, completion_tokens: 0 }
  let done = 0
  let failed = 0
  let consecutiveFailures = 0
  let error = ''
  let next = 0
  const report = () => onProgress?.({ done, total: batches.length, failed, results, usage, error })

  async function worker() {
    while (next < batches.length && !signal?.aborted && consecutiveFailures < 3) {
      const batch = batches[next++]
      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book, pairs: batch.map(mapPair) }),
          signal,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        Object.assign(results, data.results)
        if (data.usage) {
          usage.prompt_tokens += data.usage.prompt_tokens || 0
          usage.completion_tokens += data.usage.completion_tokens || 0
        }
        consecutiveFailures = 0
      } catch (err) {
        if (err.name === 'AbortError') return
        failed++
        consecutiveFailures++
        error = err.message || String(err)
      }
      done++
      report()
    }
  }
  report()
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker))
  return { results, done, total: batches.length, failed, usage, error, stopped: consecutiveFailures >= 3 }
}

// --- Comparison ----------------------------------------------------------------

const GC_LEVELS = ['none', 'loose', 'mismatch'] // Gale–Church, least → most suspicious

// How the two indicators line up over the beads both could judge.
export function compareScan(beads, results, { examples = 8 } = {}) {
  const pairs = scannable(beads)
  const scanned = pairs.filter((b) => results[b.key])

  const byGc = GC_LEVELS.map((level) => {
    const rows = scanned.filter((b) => (b.gcFlag || 'none') === level)
    const flagged = rows.filter((b) => isScanFlag(results[b.key]))
    return {
      level,
      pairs: pairs.filter((b) => (b.gcFlag || 'none') === level).length,
      scanned: rows.length,
      flagged: flagged.length,
      notMatching: rows.filter((b) => results[b.key].kind === 'not_matching').length,
      meanScore: rows.length ? rows.reduce((n, b) => n + results[b.key].score, 0) / rows.length : null,
    }
  })

  const groups = { both: [], gcOnly: [], scanOnly: [], neither: [] }
  for (const b of scanned) {
    const gc = !!b.gcFlag
    const llm = isScanFlag(results[b.key])
    groups[gc && llm ? 'both' : gc ? 'gcOnly' : llm ? 'scanOnly' : 'neither'].push(b)
  }
  const rate = (a, n) => (n ? a / n : null)
  const gcFlagged = groups.both.length + groups.gcOnly.length
  const scanFlagged = groups.both.length + groups.scanOnly.length
  const pScanGivenGc = rate(groups.both.length, gcFlagged)
  const pScanGivenNoGc = rate(groups.scanOnly.length, groups.scanOnly.length + groups.neither.length)

  const withResult = (b) => ({ ...b, result: results[b.key] })
  const byScore = (a, b) => results[a.key].score - results[b.key].score
  const byGcP = (a, b) => (a.gcP ?? 1) - (b.gcP ?? 1)

  return {
    totalBeads: beads.length,
    oneSided: beads.length - pairs.length,
    scannable: pairs.length,
    scanned: scanned.length,
    gcFlagged,
    scanFlagged,
    notMatching: scanned.filter((b) => results[b.key].kind === 'not_matching').length,
    overlap: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    // Of the passages Gale–Church flags, the share ChatGPT also flags, and
    // vice versa; lift = how much more likely a ChatGPT flag is when
    // Gale–Church flags the passage than when it does not.
    gcAlsoScan: pScanGivenGc,
    scanAlsoGc: rate(groups.both.length, scanFlagged),
    lift: pScanGivenGc !== null && pScanGivenNoGc ? pScanGivenGc / pScanGivenNoGc : null,
    byGc,
    examples: {
      both: [...groups.both].sort(byScore).slice(0, examples).map(withResult),
      gcOnly: [...groups.gcOnly].sort(byGcP).slice(0, examples).map(withResult),
      scanOnly: [...groups.scanOnly].sort(byScore).slice(0, examples).map(withResult),
    },
  }
}

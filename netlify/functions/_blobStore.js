// Durable, cross-invocation cache for the scan/verify Netlify Functions.
//
// server/scanTranslations.js's createScanStore writes to local disk
// (scans/<book>.<model>.json), which only works because Vite's own dev/preview
// server is one long-lived process. A Netlify Function is a fresh, often
// ephemeral container per invocation — nothing written to its local disk
// persists or is shared with the next request — so the cache has to live in
// Netlify's own storage instead. Netlify Blobs is that storage: a key-value
// store automatically available to functions on the site, no setup or
// credentials needed.
//
// Mirrors createScanStore's { load(book, model), save(book, model, newResults) }
// shape: one blob per book+model combination, keyed the same way the on-disk
// store named its files, so moving between the two needed no logic changes in
// scan.js / verifyIssues.js's middleware-equivalent handlers.
//
// Concurrency note: the client runs 3 scan/verify requests at once, so two
// concurrent `save()` calls for the SAME book+model can race (both read the
// current blob, both add their own new results, whichever writes last wins —
// the other's additions are lost). This is deliberately left unguarded rather
// than reaching for Blobs' conditional-write API blind without a live site to
// verify it against: the failure mode is self-healing. A dropped pair is
// simply missing from the cache next time it's requested, and since results
// are keyed by a hash of the pair's own text, it is just re-verified once —
// never served stale or wrong, only occasionally re-paid for.
import { getStore } from '@netlify/blobs'

const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_') // no dots, slashes, …

export function createBlobStore(storeName) {
  const store = getStore(storeName)
  const keyFor = (book, model) => `${safe(book)}.${safe(model)}.json`

  async function load(book, model) {
    const data = await store.get(keyFor(book, model), { type: 'json' })
    return data || { model, results: {} }
  }

  async function save(book, model, newResults) {
    const data = await load(book, model)
    Object.assign(data.results, newResults)
    data.model = model
    await store.setJSON(keyFor(book, model), data)
  }

  return { load, save }
}

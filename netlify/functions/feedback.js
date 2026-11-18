// Netlify Function for POST /api/feedback (see netlify.toml's /api/*
// redirect). server/feedback.js appends a line to a local feedback.jsonl
// file, which only works on a server with persistent disk; here each
// submission is its own Netlify Blob instead, keyed by timestamp, so
// concurrent submissions never race on a shared file (and there's nothing to
// read-modify-write). View them from the Netlify dashboard's Blobs browser,
// under the "feedback" store.
import { getStore } from '@netlify/blobs'

const MAX_MESSAGE = 2000

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  let body
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'Bad request' })
  }
  const message = String(body?.message ?? '').trim().slice(0, MAX_MESSAGE)
  if (!message) return json(400, { error: 'Empty message' })

  const at = new Date().toISOString()
  const key = `${at}-${Math.random().toString(36).slice(2, 8)}`
  await getStore('feedback').setJSON(key, { at, message })
  return json(200, { ok: true })
}

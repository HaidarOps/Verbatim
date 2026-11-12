// Run the app's real book-reading code (src/chapters.js, which uses epubjs and
// the DOM) in Node: jsdom provides the DOM and a tiny static server provides
// public/books over HTTP, the way the dev server does for the page.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const BOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'books')

// Serve public/books on a random local port. Returns { base, close }.
export async function serveBooks() {
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/books\//, '')
    if (!/^[\w.-]+\.epub$/.test(name)) {
      res.statusCode = 404
      return res.end()
    }
    try {
      const data = await readFile(path.join(BOOKS_DIR, name))
      res.setHeader('Content-Type', 'application/epub+zip')
      res.end(data)
    } catch {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  installDom(base)
  return { base, close: () => new Promise((resolve) => server.close(resolve)) }
}

// Browser globals epubjs needs. Object URLs only stand in for the book's
// images and stylesheets, which reading text doesn't need.
function installDom(base) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${base}/` })
  for (const k of ['window', 'document', 'DOMParser', 'XMLSerializer', 'Node', 'NodeFilter', 'Blob', 'XMLHttpRequest']) {
    globalThis[k] = dom.window[k]
  }
  for (const U of [globalThis.URL, dom.window.URL]) {
    U.createObjectURL = () => 'blob:stub'
    U.revokeObjectURL = () => {}
  }
}

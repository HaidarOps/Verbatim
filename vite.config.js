import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { feedbackMiddleware } from './server/feedback.js'
import { rateTranslationMiddleware } from './server/rateTranslation.js'
import { createScanStore, scanMiddleware } from './server/scanTranslations.js'
import { verifyMiddleware } from './server/verifyIssues.js'

// Serves the OpenAI-backed endpoints from the dev (and preview) server, so
// the key is read here on the server and never shipped to the browser:
//   POST /api/rate-translation   rate one highlighted passage (popup)
//   GET/POST /api/scan           whole-book scan (cheap model), cached in scans/
//   GET/POST /api/verify         confirm Gale–Church red signals (strong model),
//                                cached in scans/<book>.verify-<model>.json
// Put OPENAI_API_KEY (and optionally OPENAI_MODEL / OPENAI_SCAN_MODEL /
// OPENAI_VERIFY_MODEL) in .env.local. They have no VITE_ prefix, so Vite never
// exposes them to pages.
function openAiEndpoints(env) {
  const key = () => env.OPENAI_API_KEY || process.env.OPENAI_API_KEY
  // One store over scans/ for both the scan and verify endpoints; the model
  // label (verify-<model>) keeps their files apart.
  const store = createScanStore(path.resolve('scans'))
  const rate = rateTranslationMiddleware(() => ({
    apiKey: key(),
    model: env.OPENAI_MODEL || process.env.OPENAI_MODEL,
  }))
  const scan = scanMiddleware(
    () => ({
      apiKey: key(),
      model: env.OPENAI_SCAN_MODEL || process.env.OPENAI_SCAN_MODEL,
      reasoning: env.OPENAI_SCAN_REASONING || process.env.OPENAI_SCAN_REASONING,
    }),
    store,
  )
  const verify = verifyMiddleware(
    () => ({
      apiKey: key(),
      // Default lives in verifyIssues.js (gpt-5-mini); OPENAI_VERIFY_MODEL
      // overrides it, else fall back to the rating model.
      model: env.OPENAI_VERIFY_MODEL || process.env.OPENAI_VERIFY_MODEL || env.OPENAI_MODEL || process.env.OPENAI_MODEL,
      reasoning: env.OPENAI_VERIFY_REASONING || process.env.OPENAI_VERIFY_REASONING,
    }),
    store,
  )
  const mount = (server) => {
    server.middlewares.use('/api/rate-translation', rate)
    server.middlewares.use('/api/scan', scan)
    server.middlewares.use('/api/verify', verify)
    server.middlewares.use('/api/feedback', feedbackMiddleware(path.resolve('feedback')))
  }
  return { name: 'openai-endpoints', configureServer: mount, configurePreviewServer: mount }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), openAiEndpoints(loadEnv(mode, process.cwd(), ''))],
  // Scan results are written to scans/ while the dev server runs; don't
  // reload the page every time a batch is saved.
  server: { watch: { ignored: ['**/scans/**'] } },
}))

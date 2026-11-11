import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { rateTranslationMiddleware } from './server/rateTranslation.js'

// Serves POST /api/rate-translation from the dev (and preview) server, so the
// OpenAI key is read here on the server and never shipped to the browser.
// Put OPENAI_API_KEY (and optionally OPENAI_MODEL) in .env.local. They have no
// VITE_ prefix, so Vite never exposes them to page code.
function translationRater(env) {
  const middleware = rateTranslationMiddleware(() => ({
    apiKey: env.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || process.env.OPENAI_MODEL,
  }))
  return {
    name: 'translation-rater',
    configureServer(server) {
      server.middlewares.use('/api/rate-translation', middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/rate-translation', middleware)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), translationRater(loadEnv(mode, process.cwd(), ''))],
}))

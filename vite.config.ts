import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * GitHub Pages cannot set response headers, so the Content-Security-Policy
 * is delivered as a <meta> tag instead. It is injected only into the
 * production build: in dev, @vitejs/plugin-react adds an inline Fast Refresh
 * preamble that `script-src 'self'` would block.
 *
 * Notes on the directives:
 * - 'wasm-unsafe-eval' lets the Tesseract OCR core compile its WebAssembly.
 * - tessdata.projectnaptha.com is where tesseract.js fetches trained language
 *   models on first use (see src/lib/ocr.ts). No document content goes there.
 * - blob: in worker-src/child-src covers pdf.js's fallback worker.
 * - 'unsafe-inline' in style-src is needed for React's inline style attributes.
 * - frame-ancestors is not honoured in a <meta> policy, so it is omitted.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' blob: data: https://tessdata.projectnaptha.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function cspMeta(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
        injectTo: 'head-prepend',
      },
    ],
  }
}

export default defineConfig({
  plugins: [react(), cspMeta()],
  server: { port: 5173 },
})

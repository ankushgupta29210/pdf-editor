/**
 * Tesseract.js needs its worker script and the WASM "core" build at runtime.
 * They are copied out of node_modules (like pdf.js's assets) so OCR runs
 * fully offline from this app's own origin instead of fetching code from a
 * third-party CDN. The recognition language data (trained models) is copied
 * too, into public/tesseract/lang, so OCR never reaches out to a CDN.
 *
 * Safe to run before `npm install tesseract.js` has happened: it warns and
 * skips instead of failing the dev/build script, so OCR simply stays
 * unavailable until the package is installed.
 */
import { cp, mkdir, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const to = join(root, 'public', 'tesseract')

await rm(to, { recursive: true, force: true })
await mkdir(to, { recursive: true })

const workerSrc = join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js')
if (existsSync(workerSrc)) {
  await cp(workerSrc, join(to, 'worker.min.js'))
} else {
  console.warn(
    '[tesseract-assets] tesseract.js is not installed yet (run `npm install tesseract.js`) — OCR will stay disabled until then.',
  )
}

const coreDir = join(root, 'node_modules', 'tesseract.js-core')
if (existsSync(coreDir)) {
  // Copy every core variant (simd/non-simd, lstm/legacy): the worker picks the
  // right one for the browser at runtime, so all of them need to be reachable
  // under the same public path.
  const files = (await readdir(coreDir)).filter((f) => /\.(wasm|js)$/.test(f))
  await Promise.all(files.map((f) => cp(join(coreDir, f), join(to, f))))
  console.log(`copied Tesseract.js worker + ${files.length} core files into public/tesseract`)
} else {
  console.warn('[tesseract-assets] tesseract.js-core not found — core WASM files were not copied.')
}

// Trained language models. Without these, tesseract.js falls back to
// downloading them from cdn.jsdelivr.net, which the production CSP blocks (and
// which would break the "nothing leaves this site" promise). The "best_int"
// variant is the one tesseract.js picks for the default LSTM-only engine.
// Keep in step with OCR_LANGUAGES in src/lib/ocr.ts.
const LANGS = [
  'eng', 'spa', 'fra', 'deu', 'por', 'ita', 'nld', 'pol', 'tur', 'vie', 'ind',
  'rus', 'ukr', 'ell', 'ara', 'heb', 'hin', 'ben', 'tha',
  'chi_sim', 'chi_tra', 'jpn', 'kor',
]
for (const lang of LANGS) {
  const src = join(root, 'node_modules', '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`)
  if (existsSync(src)) {
    await mkdir(join(to, 'lang'), { recursive: true })
    await cp(src, join(to, 'lang', `${lang}.traineddata.gz`))
    console.log(`copied ${lang}.traineddata.gz into public/tesseract/lang`)
  } else {
    console.warn(
      `[tesseract-assets] @tesseract.js-data/${lang} is not installed — OCR in ${lang} will fail until it is (npm install).`,
    )
  }
}

/**
 * Tesseract.js needs its worker script and the WASM "core" build at runtime.
 * They are copied out of node_modules (like pdf.js's assets) so OCR runs
 * fully offline from this app's own origin instead of fetching code from a
 * third-party CDN. The recognition *language data* (a trained model, not
 * app code) is not copied here — see src/lib/ocr.ts for that trade-off.
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

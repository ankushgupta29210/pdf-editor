/**
 * pdf.js needs its standard-font and CMap data files at runtime to render PDFs
 * that rely on the base-14 fonts without embedding them, or that use CJK
 * encodings. They are copied out of node_modules so they always match the
 * installed pdfjs-dist version rather than being committed and drifting.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'pdfjs-dist')
const to = join(root, 'public', 'pdfjs')

await rm(to, { recursive: true, force: true })
await mkdir(to, { recursive: true })
for (const dir of ['standard_fonts', 'cmaps']) {
  await cp(join(from, dir), join(to, dir), { recursive: true })
}
console.log('copied pdf.js standard_fonts and cmaps into public/pdfjs')

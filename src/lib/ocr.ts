import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFPage,
  PDFRef,
  type PDFOperatorNames,
} from 'pdf-lib'
import { addGlyphlessFont, utf16Hex } from './glyphless'
import { openWithPdfjs } from './pdfjs'
import { renderPageToJpeg } from './render'
import { yieldToBrowser } from './limits'

/** Page render resolution for OCR — high enough for good accuracy on typical
 *  scans without ballooning recognition time. ~180-220 DPI on a US letter page. */
const OCR_SCALE = 2.4
/** Below this Tesseract confidence (0-100), a "word" is more likely noise
 *  (stray marks, table rules) than real text, so it is left out of the
 *  searchable layer rather than polluting it with garbage matches. */
const MIN_CONFIDENCE = 45

export interface OcrLanguage {
  code: string
  label: string
}

/**
 * Languages whose models ship with the site (see
 * scripts/copy-tesseract-assets.mjs — keep the two lists in step). Each model
 * is 1–3 MB and is only downloaded the first time someone picks it.
 */
export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: 'eng', label: 'English' },
  { code: 'spa', label: 'Spanish — Español' },
  { code: 'fra', label: 'French — Français' },
  { code: 'deu', label: 'German — Deutsch' },
  { code: 'por', label: 'Portuguese — Português' },
  { code: 'ita', label: 'Italian — Italiano' },
  { code: 'nld', label: 'Dutch — Nederlands' },
  { code: 'pol', label: 'Polish — Polski' },
  { code: 'tur', label: 'Turkish — Türkçe' },
  { code: 'vie', label: 'Vietnamese — Tiếng Việt' },
  { code: 'ind', label: 'Indonesian — Bahasa Indonesia' },
  { code: 'rus', label: 'Russian — Русский' },
  { code: 'ukr', label: 'Ukrainian — Українська' },
  { code: 'ell', label: 'Greek — Ελληνικά' },
  { code: 'ara', label: 'Arabic — العربية' },
  { code: 'heb', label: 'Hebrew — עברית' },
  { code: 'hin', label: 'Hindi — हिन्दी' },
  { code: 'ben', label: 'Bengali — বাংলা' },
  { code: 'tha', label: 'Thai — ไทย' },
  { code: 'chi_sim', label: 'Chinese (Simplified) — 简体中文' },
  { code: 'chi_tra', label: 'Chinese (Traditional) — 繁體中文' },
  { code: 'jpn', label: 'Japanese — 日本語' },
  { code: 'kor', label: 'Korean — 한국어' },
]

/** Tesseract language string: other languages also read English, since
 *  real documents mix in English names, numbers and headings. */
export function tesseractLangs(code: string): string {
  return code === 'eng' ? 'eng' : `${code}+eng`
}

export interface OcrProgress {
  page: number
  totalPages: number
  /** 0..1 within the current page */
  fraction: number
}

const op = (name: string, ...args: Array<number | PDFName | PDFHexString>) =>
  PDFOperator.of(
    name as PDFOperatorNames,
    args.map((a) => (typeof a === 'number' ? PDFNumber.of(a) : a)),
  )

function flattenWords(page: Tesseract.Page): Tesseract.Word[] {
  const out: Tesseract.Word[] = []
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) out.push(word)
      }
    }
  }
  return out
}

/**
 * Adds an invisible, positioned text layer to every page of `bytes` using
 * OCR, so pages that started as flat scans become selectable and searchable
 * — without changing how the page looks. The recognition itself runs
 * entirely in the browser: the worker, the WASM core and the trained language
 * model are all served from this app, not a third party (the model is cached
 * by the browser after the first run). No page content is ever sent anywhere.
 */
export async function makeSearchable(
  bytes: Uint8Array,
  opts: { lang?: string; onProgress?: (p: OcrProgress) => void } = {},
): Promise<Uint8Array> {
  const Tesseract = await import('tesseract.js')
  const lang = opts.lang ?? 'eng'
  const base = import.meta.env.BASE_URL

  const [doc, proxy] = await Promise.all([PDFDocument.load(bytes), openWithPdfjs(bytes)])
  const font = addGlyphlessFont(doc)
  const pages = doc.getPages()
  const total = pages.length

  // tesseract.js swallows a failed language load inside createWorker() and
  // reports it only through `errorHandler` (or an uncaught throw), so the
  // promise would otherwise never settle and the UI would sit on "page 0"
  // forever. Route that error into a rejection we can show to the user.
  let failLoad: (reason: Error) => void = () => undefined
  const loadFailed = new Promise<never>((_, reject) => {
    failLoad = reject
  })
  // errorHandler can also fire later for a failed recognize() (which rejects
  // on its own); don't let this side promise surface as an unhandled rejection.
  loadFailed.catch(() => undefined)
  const worker = await Promise.race([
    Tesseract.createWorker(tesseractLangs(lang).split('+'), undefined, {
      workerPath: `${base}tesseract/worker.min.js`,
      corePath: `${base}tesseract/`,
      // Self-hosted model (copied by scripts/copy-tesseract-assets.mjs), so
      // nothing is fetched from a third-party CDN.
      langPath: `${base}tesseract/lang`,
      errorHandler: (err: unknown) =>
        failLoad(
          new Error(
            `Could not load the ${OCR_LANGUAGES.find((l) => l.code === lang)?.label.split(' — ')[0] ?? lang} OCR model (${String(err).replace(/^Error:\s*/, '')}). ` +
              'Check your connection and try again.',
          ),
        ),
    }),
    loadFailed,
  ])

  try {
    const canvas = document.createElement('canvas')
    for (let i = 0; i < total; i++) {
      opts.onProgress?.({ page: i + 1, totalPages: total, fraction: 0 })

      const shot = await renderPageToJpeg(proxy, i, { scale: OCR_SCALE, quality: 0.92, canvas })
      // Blob wants a real ArrayBuffer, not the ArrayBufferLike a typed array
      // subarray can carry, so copy into a fresh one rather than widen the type.
      const buf = new ArrayBuffer(shot.bytes.byteLength)
      new Uint8Array(buf).set(shot.bytes)
      const { data } = await worker.recognize(new Blob([buf], { type: 'image/jpeg' }), {}, { blocks: true })

      opts.onProgress?.({ page: i + 1, totalPages: total, fraction: 1 })
      placeInvisibleText(pages[i], flattenWords(data), shot, font)
      await yieldToBrowser()
    }
  } finally {
    await worker.terminate()
  }

  return doc.save({ useObjectStreams: true })
}

function placeInvisibleText(
  page: PDFPage,
  words: Tesseract.Word[],
  shot: { width: number; height: number; pointWidth: number; pointHeight: number },
  fontRef: PDFRef,
) {
  const scaleX = shot.pointWidth / shot.width
  const scaleY = shot.pointHeight / shot.height
  const fontName = PDFName.of('FOcrText')
  page.node.setFontDictionary(fontName, fontRef)

  const ops: PDFOperator[] = [op('q'), op('BT'), op('Tr', 3)]
  for (const word of words) {
    const text = (word.text ?? '').trim()
    if (!text || word.confidence < MIN_CONFIDENCE) continue
    // PDF text is stored in visual (left-to-right) order and extractors apply
    // the bidi algorithm when reading it back, so right-to-left words
    // (Arabic, Hebrew) are written reversed to come out in reading order.
    const visual = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(text)
      ? [...text].reverse().join('')
      : text
    const hex = utf16Hex(visual)
    if (!hex) continue
    const { x0, y0, x1, y1 } = word.bbox
    const wPt = (x1 - x0) * scaleX
    const hPt = (y1 - y0) * scaleY
    if (wPt <= 0 || hPt <= 0) continue
    // pdf.js/Tesseract measure from the top-left; PDF space is bottom-left.
    const xPt = x0 * scaleX
    const yPt = shot.pointHeight - y1 * scaleY + hPt * 0.15
    const size = Math.max(1, hPt)
    // Every glyph is 0.5 em wide (DW 500), so horizontal scaling stretches the
    // run to the word's real width — a search highlight then covers the word.
    const natural = (hex.length / 4) * 0.5 * size
    const tz = Math.max(1, Math.min(2000, (wPt / natural) * 100))
    ops.push(
      op('Tf', fontName, size),
      op('Tz', tz),
      op('Tm', 1, 0, 0, 1, xPt, yPt),
      op('Tj', PDFHexString.of(hex)),
    )
  }
  ops.push(op('ET'), op('Q'))
  page.pushOperators(...ops)
}

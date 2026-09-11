import { PDFDocument, PDFFont, PDFPage, StandardFonts } from 'pdf-lib'
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

/** Languages with self-hosted worker/core assets ready to go. Tesseract
 *  supports many more; add here once you want to offer them. */
export const OCR_LANGUAGES: OcrLanguage[] = [{ code: 'eng', label: 'English' }]

export interface OcrProgress {
  page: number
  totalPages: number
  /** 0..1 within the current page */
  fraction: number
}

/** pdf-lib's standard fonts only cover WinAnsi; swap anything else for a
 *  placeholder so a stray recognised character can't fail the whole save(). */
function toWinAnsi(text: string): string {
  return text.replace(/[^\x00-\xFF€‘’“”–—•…]/g, '?')
}

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
 * entirely in the browser (the worker and WASM core are served from this
 * app, not a third party); the one exception is the trained language model,
 * which the library fetches from its own CDN the first time a language is
 * used and then caches, since bundling every language's model in the app
 * would be tens of megabytes each. No page content is ever sent anywhere.
 */
export async function makeSearchable(
  bytes: Uint8Array,
  opts: { lang?: string; onProgress?: (p: OcrProgress) => void } = {},
): Promise<Uint8Array> {
  const Tesseract = await import('tesseract.js')
  const lang = opts.lang ?? 'eng'
  const base = import.meta.env.BASE_URL

  const [doc, proxy] = await Promise.all([PDFDocument.load(bytes), openWithPdfjs(bytes)])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = doc.getPages()
  const total = pages.length

  const worker = await Tesseract.createWorker(lang, undefined, {
    workerPath: `${base}tesseract/worker.min.js`,
    corePath: `${base}tesseract/`,
  })

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
  font: PDFFont,
) {
  const scaleX = shot.pointWidth / shot.width
  const scaleY = shot.pointHeight / shot.height

  for (const word of words) {
    const text = toWinAnsi(word.text?.trim() ?? '')
    if (!text || word.confidence < MIN_CONFIDENCE) continue
    const { x0, y0, x1, y1 } = word.bbox
    const wPt = (x1 - x0) * scaleX
    const hPt = (y1 - y0) * scaleY
    if (wPt <= 0 || hPt <= 0) continue

    const xPt = x0 * scaleX
    // pdf.js/Tesseract measure from the top-left; PDF space is bottom-left.
    const yPt = shot.pointHeight - y1 * scaleY

    // Helvetica's metrics won't match whatever font the scan was printed in,
    // so the run is stretched to the OCR'd word's own width — that keeps a
    // "find in page" highlight roughly where the real word sits, even though
    // these glyphs are never actually seen (opacity 0 below).
    const natural = font.widthOfTextAtSize(text, hPt) || 1
    const size = Math.max(1, Math.min(hPt * 1.35, (wPt / natural) * hPt))

    try {
      page.drawText(text, { x: xPt, y: yPt, size, font, opacity: 0 })
    } catch {
      // A handful of unencodable glyphs shouldn't sink the rest of the page.
    }
  }
}

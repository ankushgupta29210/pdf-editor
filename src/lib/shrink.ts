import { PDFDocument } from 'pdf-lib'
import { openWithPdfjs } from './pdfjs'
import { encodeCanvasJpeg, renderPageToJpeg } from './render'
import { yieldToBrowser } from './limits'

/** Keeps canvases inside browser texture limits on very large pages. */
const MAX_EDGE = 5000
/** Below this the page stops being readable, so the run gives up instead. */
const MIN_DPI = 40
const MIN_QUALITY = 0.28
const MAX_QUALITY = 0.86
/** Rough bytes-per-pixel of a JPEG page at mid quality, used for the first guess. */
const BYTES_PER_PIXEL = 0.1

export interface ShrinkOptions {
  targetBytes: number
  /** The sharpest the output may be; the run only ever works down from here. */
  maxDpi: number
  grayscale: boolean
  signal?: AbortSignal
  onProgress?: (p: ShrinkProgress) => void
}

export interface ShrinkProgress {
  phase: 'reading' | 'opening' | 'pages' | 'writing'
  done: number
  total: number
  /** Page images written so far — what the size meter counts. */
  bytes: number
  dpi: number
}

export interface ShrinkResult {
  bytes: Uint8Array
  pageCount: number
  /** True when even the lowest settings could not fit the target. */
  missedTarget: boolean
}

export class ShrinkCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'ShrinkCancelled'
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * Compresses a PDF towards a size the user names, without ever opening it in
 * the editor. Pages are rendered one at a time straight into the output, so
 * peak memory is the input file plus one canvas plus the (small) result —
 * which is what makes a 300–400 MB input survivable in a tab.
 *
 * There is no way to know what a page will encode to without encoding it, so
 * rather than compress the whole file repeatedly at different settings, the run
 * spends a budget: each page gets its share of what is left, and resolution and
 * quality are nudged after every page to keep the rest of the document on
 * track. One pass, and the answer lands close to the target.
 */
export async function shrinkToTarget(file: File, opts: ShrinkOptions): Promise<ShrinkResult> {
  const stop = () => {
    if (opts.signal?.aborted) throw new ShrinkCancelled()
  }
  const report = (p: Partial<ShrinkProgress> & Pick<ShrinkProgress, 'phase'>) =>
    opts.onProgress?.({ done: 0, total: 0, bytes: 0, dpi: opts.maxDpi, ...p })

  report({ phase: 'reading' })
  const bytes = new Uint8Array(await file.arrayBuffer())
  stop()

  report({ phase: 'opening' })
  // The buffer is detached by this call; nothing below may touch `bytes` again.
  const src = await openWithPdfjs(bytes, { handOver: true })

  const out = await PDFDocument.create()
  const canvas = document.createElement('canvas')
  const total = src.numPages

  try {
    stop()
    // The page images are not the whole file: cross-references, the page tree
    // and each image's own dictionary all cost bytes. Hold some back for them.
    const budget = Math.max(opts.targetBytes * 0.93 - total * 420, total * 2048)

    // Aim the first page using the shape of page one, then let the loop correct.
    const first = await src.getPage(1)
    const view = first.getViewport({ scale: 1 })
    const inches = (view.width / 72) * (view.height / 72)
    let dpi = clamp(
      Math.sqrt(budget / total / BYTES_PER_PIXEL / Math.max(inches, 1)),
      MIN_DPI,
      opts.maxDpi,
    )
    let quality = 0.75
    first.cleanup()

    let spent = 0
    for (let i = 0; i < total; i++) {
      stop()
      const left = Math.max(budget - spent, 0)
      const pageBudget = Math.max(left / (total - i), 1024)

      let shot = await renderPageToJpeg(src, i, {
        scale: dpi / 72,
        quality,
        grayscale: opts.grayscale,
        canvas,
        maxEdge: MAX_EDGE,
      })
      // A page that badly overshoots its share is re-encoded off the canvas it
      // is already painted on — far cheaper than letting it eat the pages after
      // it and then rendering those smaller to compensate.
      for (let retry = 0; retry < 2; retry++) {
        if (shot.bytes.byteLength <= pageBudget * 1.4 || quality <= MIN_QUALITY) break
        quality = Math.max(MIN_QUALITY, quality * 0.78)
        shot = { ...shot, bytes: await encodeCanvasJpeg(canvas, quality, i + 1) }
      }

      const jpg = await out.embedJpg(shot.bytes)
      // Keep the original point size so the document still prints to scale.
      const page = out.addPage([shot.pointWidth, shot.pointHeight])
      page.drawImage(jpg, { x: 0, y: 0, width: shot.pointWidth, height: shot.pointHeight })
      spent += shot.bytes.byteLength

      // Steer what is left. Quality moves first because it costs no sharpness
      // of layout; resolution only gives way once quality is already low.
      const remaining = total - i - 1
      if (remaining > 0) {
        const share = Math.max(budget - spent, 0) / remaining
        const ratio = share / Math.max(shot.bytes.byteLength, 1)
        if (ratio < 0.95) {
          if (quality > 0.5) quality = Math.max(0.5, quality * clamp(ratio, 0.8, 1))
          else dpi = Math.max(MIN_DPI, dpi * clamp(Math.sqrt(ratio), 0.8, 1))
        } else if (ratio > 1.4) {
          if (dpi < opts.maxDpi) dpi = Math.min(opts.maxDpi, dpi * clamp(Math.sqrt(ratio), 1, 1.12))
          else if (quality < MAX_QUALITY) quality = Math.min(MAX_QUALITY, quality * 1.05)
        }
      }

      report({ phase: 'pages', done: i + 1, total, bytes: spent, dpi: Math.round(dpi) })
      await yieldToBrowser()
    }
  } finally {
    await src.destroy()
    canvas.width = 0
    canvas.height = 0
  }

  stop()
  report({ phase: 'writing', done: total, total })
  await yieldToBrowser()
  out.setProducer('')
  out.setCreator('')
  const result = await out.save({ useObjectStreams: true, updateFieldAppearances: false })
  return {
    bytes: result,
    pageCount: total,
    missedTarget: result.byteLength > opts.targetBytes,
  }
}

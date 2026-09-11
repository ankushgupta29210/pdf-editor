import { PDFDocument } from 'pdf-lib'
import { openWithPdfjs } from './pdfjs'
import { renderPageToJpeg } from './render'
import { yieldToBrowser } from './limits'
import type { CompressSettings } from './compress-presets'

/** Keeps canvases inside browser texture limits on very large pages. */
const MAX_EDGE = 5000

/**
 * Rasterising is what actually shrinks a PDF in the browser: each page is
 * re-rendered at a chosen resolution and stored as a single JPEG. Text stops
 * being selectable, which is why 'optimize' exists as the non-destructive mode.
 */
export async function compressPdf(
  bytes: Uint8Array,
  settings: CompressSettings,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  if (settings.mode === 'optimize') {
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
    })
    if (settings.stripMetadata) {
      doc.setTitle('')
      doc.setAuthor('')
      doc.setSubject('')
      doc.setKeywords([])
      doc.setProducer('')
      doc.setCreator('')
    }
    onProgress?.(1, 1)
    return doc.save({ useObjectStreams: true, updateFieldAppearances: false })
  }

  const src = await openWithPdfjs(bytes)
  const out = await PDFDocument.create()
  const canvas = document.createElement('canvas')

  try {
    for (let i = 0; i < src.numPages; i++) {
      const shot = await renderPageToJpeg(src, i, {
        scale: settings.dpi / 72,
        quality: settings.quality,
        grayscale: settings.grayscale,
        canvas,
        maxEdge: MAX_EDGE,
      })
      const jpg = await out.embedJpg(shot.bytes)
      // Keep the original point size so the document still prints to scale.
      const page = out.addPage([shot.pointWidth, shot.pointHeight])
      page.drawImage(jpg, { x: 0, y: 0, width: shot.pointWidth, height: shot.pointHeight })
      onProgress?.(i + 1, src.numPages)
      await yieldToBrowser()
    }
  } finally {
    await src.destroy()
    canvas.width = 0
    canvas.height = 0
  }

  if (settings.stripMetadata) {
    out.setProducer('')
    out.setCreator('')
  }
  return out.save({ useObjectStreams: true, updateFieldAppearances: false })
}

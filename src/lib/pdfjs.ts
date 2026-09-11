import type { PDFDocumentProxy } from 'pdfjs-dist'

let mod: Promise<typeof import('pdfjs-dist')> | null = null

/**
 * pdf.js is around 400 KB, so it is fetched only once the user actually opens
 * a file rather than being part of the initial page load. The worker itself is
 * a separate request that pdf.js makes on demand.
 */
function pdfjs() {
  if (!mod) {
    mod = (async () => {
      const [lib, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ])
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    })()
  }
  return mod
}

/**
 * pdf.js transfers (and detaches) the buffer it is handed, so every call gets
 * its own copy — the original bytes stay usable for pdf-lib on export.
 */
export async function openWithPdfjs(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const lib = await pdfjs()
  const base = import.meta.env.BASE_URL
  return lib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    // Without these, PDFs that reference the base-14 fonts without embedding
    // them, or that use CJK encodings, render with missing glyphs.
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
    cMapUrl: `${base}pdfjs/cmaps/`,
    cMapPacked: true,
  }).promise
}

export type { PDFDocumentProxy }

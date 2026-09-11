import {
  BlendMode,
  PDFDocument,
  PDFEmbeddedPage,
  PDFFont,
  PDFImage,
  PDFPage,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib'
import type { Annotation, FontKey, PageItem, SourceDoc, StoredImage, TextAnn } from './types'
import { displaySize, hexToRgb, rotationPlacement } from './geometry'
import { renderPageToJpeg } from './render'
import { yieldToBrowser } from './limits'

const STANDARD: Record<FontKey, Record<string, StandardFonts>> = {
  Helvetica: {
    '': StandardFonts.Helvetica,
    b: StandardFonts.HelveticaBold,
    i: StandardFonts.HelveticaOblique,
    bi: StandardFonts.HelveticaBoldOblique,
  },
  Times: {
    '': StandardFonts.TimesRoman,
    b: StandardFonts.TimesRomanBold,
    i: StandardFonts.TimesRomanItalic,
    bi: StandardFonts.TimesRomanBoldItalic,
  },
  Courier: {
    '': StandardFonts.Courier,
    b: StandardFonts.CourierBold,
    i: StandardFonts.CourierOblique,
    bi: StandardFonts.CourierBoldOblique,
  },
}

function standardFontName(key: FontKey, bold: boolean, italic: boolean): StandardFonts {
  return STANDARD[key][`${bold ? 'b' : ''}${italic ? 'i' : ''}`]
}

/** Greedy word wrap that also honours explicit newlines. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === '') continue
      const candidate = line + word
      if (line !== '' && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        out.push(line.trimEnd())
        line = word.trimStart()
      } else {
        line = candidate
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

class FontCache {
  private cache = new Map<string, Promise<PDFFont>>()
  constructor(private doc: PDFDocument) {}
  get(key: FontKey, bold: boolean, italic: boolean): Promise<PDFFont> {
    const name = standardFontName(key, bold, italic)
    let hit = this.cache.get(name)
    if (!hit) {
      hit = this.doc.embedFont(name)
      this.cache.set(name, hit)
    }
    return hit
  }
}

/**
 * pdf-lib's standard fonts only cover WinAnsi. Anything outside it would throw
 * during save, so swap unencodable characters for a placeholder instead of
 * losing the whole export.
 */
function toWinAnsi(text: string): string {
  return text.replace(/[^\x00-\xFF€‘’“”–—•…]/g, '?')
}

async function drawText(page: PDFPage, a: TextAnn, baseH: number, fonts: FontCache) {
  const font = await fonts.get(a.font, a.bold, a.italic)
  const { r, g, b } = hexToRgb(a.color)
  const lines = wrapText(toWinAnsi(a.text), font, a.fontSize, Math.max(a.w, 1))
  const step = a.fontSize * a.lineHeight
  lines.forEach((line, i) => {
    if (line === '') return
    const lineWidth = font.widthOfTextAtSize(line, a.fontSize)
    let x = a.x
    if (a.align === 'center') x = a.x + (a.w - lineWidth) / 2
    else if (a.align === 'right') x = a.x + a.w - lineWidth
    // The DOM lays lines out from the top; PDF text sits on its baseline.
    const baselineFromTop = i * step + (step + a.fontSize * 0.72) / 2
    page.drawText(line, {
      x,
      y: baseH - (a.y + baselineFromTop),
      size: a.fontSize,
      font,
      color: rgb(r, g, b),
    })
  })
}

function drawShape(page: PDFPage, a: Annotation, baseH: number) {
  const top = (y: number) => baseH - y
  switch (a.kind) {
    case 'rect': {
      const s = hexToRgb(a.stroke)
      const f = a.fill ? hexToRgb(a.fill) : null
      page.drawRectangle({
        x: a.x,
        y: top(a.y + a.h),
        width: a.w,
        height: a.h,
        borderColor: a.strokeWidth > 0 ? rgb(s.r, s.g, s.b) : undefined,
        borderWidth: a.strokeWidth,
        color: f ? rgb(f.r, f.g, f.b) : undefined,
        opacity: a.opacity,
        borderOpacity: a.opacity,
      })
      break
    }
    case 'ellipse': {
      const s = hexToRgb(a.stroke)
      const f = a.fill ? hexToRgb(a.fill) : null
      page.drawEllipse({
        x: a.x + a.w / 2,
        y: top(a.y + a.h / 2),
        xScale: Math.max(a.w / 2, 0.1),
        yScale: Math.max(a.h / 2, 0.1),
        borderColor: a.strokeWidth > 0 ? rgb(s.r, s.g, s.b) : undefined,
        borderWidth: a.strokeWidth,
        color: f ? rgb(f.r, f.g, f.b) : undefined,
        opacity: a.opacity,
        borderOpacity: a.opacity,
      })
      break
    }
    case 'line': {
      const s = hexToRgb(a.stroke)
      page.drawLine({
        start: { x: a.x, y: top(a.y) },
        end: { x: a.x + a.w, y: top(a.y + a.h) },
        thickness: a.strokeWidth,
        color: rgb(s.r, s.g, s.b),
        opacity: a.opacity,
      })
      break
    }
    case 'highlight': {
      const c = hexToRgb(a.color)
      page.drawRectangle({
        x: a.x,
        y: top(a.y + a.h),
        width: a.w,
        height: a.h,
        color: rgb(c.r, c.g, c.b),
        opacity: a.opacity,
        blendMode: BlendMode.Multiply,
      })
      break
    }
    case 'ink': {
      const c = hexToRgb(a.stroke)
      for (const stroke of a.strokes) {
        if (stroke.length === 1) {
          const [px, py] = stroke[0]
          page.drawCircle({
            x: a.x + px * a.w,
            y: top(a.y + py * a.h),
            size: a.strokeWidth / 2,
            color: rgb(c.r, c.g, c.b),
          })
          continue
        }
        for (let i = 1; i < stroke.length; i++) {
          const [x1, y1] = stroke[i - 1]
          const [x2, y2] = stroke[i]
          page.drawLine({
            start: { x: a.x + x1 * a.w, y: top(a.y + y1 * a.h) },
            end: { x: a.x + x2 * a.w, y: top(a.y + y2 * a.h) },
            thickness: a.strokeWidth,
            color: rgb(c.r, c.g, c.b),
            lineCap: 1,
          })
        }
      }
      break
    }
  }
}

/** Identifies one source page, so work can be cached and probed per page. */
const pageKey = (item: PageItem) => `${item.srcId}:${item.srcIndex}`

const SAVE_OPTIONS = {
  useObjectStreams: true,
  // We never build form fields, and this step walks any AcroForm copied in from
  // a source file — a common place for malformed PDFs to throw.
  updateFieldAppearances: false,
} as const

const LOAD_OPTIONS = { ignoreEncryption: true, throwOnInvalidObject: false } as const

/** Resolution used when a page has to be flattened to an image to survive export. */
const FALLBACK_SCALE = 2.2

export interface FallbackPage {
  /** 1-based position in the exported document */
  pageNumber: number
  fileName: string
}

export interface BuildOptions {
  /** strip title/author/producer metadata from the result */
  stripMetadata?: boolean
  onProgress?: (done: number, total: number) => void
  /** called when pages had to be flattened to images to be exportable at all */
  onFallback?: (pages: FallbackPage[]) => void
}

/**
 * Wraps `draw` in the transform that turns unrotated base space into the page's
 * displayed space — the exact counterpart of the CSS transform the editor uses.
 */
function withLayer(page: PDFPage, item: PageItem, draw: () => void | Promise<void>) {
  const layer = rotationPlacement(item.rotate, item.baseWidth, item.baseHeight)
  const rad = (layer.ccw * Math.PI) / 180
  const cos = Math.round(Math.cos(rad))
  const sin = Math.round(Math.sin(rad))
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(cos, sin, -sin, cos, layer.tx, layer.ty),
  )
  const done = draw()
  const pop = () => page.pushOperators(popGraphicsState())
  return done instanceof Promise ? done.then(pop) : pop()
}

async function assemble(
  pages: PageItem[],
  sources: Map<string, SourceDoc>,
  annotations: Record<string, Annotation[]>,
  images: Map<string, StoredImage>,
  opts: BuildOptions,
  rasterKeys: Set<string>,
): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  const fonts = new FontCache(out)
  const loaded = new Map<string, PDFDocument | null>()
  const embedded = new Map<string, PDFEmbeddedPage>()
  const rasters = new Map<string, PDFImage>()
  const embeddedImages = new Map<string, PDFImage>()
  const canvas = rasterKeys.size ? document.createElement('canvas') : null

  const getDoc = async (srcId: string, bytes: Uint8Array) => {
    if (!loaded.has(srcId)) {
      try {
        loaded.set(srcId, await PDFDocument.load(bytes, LOAD_OPTIONS))
      } catch {
        loaded.set(srcId, null)
      }
    }
    return loaded.get(srcId)!
  }

  for (const [i, item] of pages.entries()) {
    const src = sources.get(item.srcId)
    if (!src) continue

    const key = pageKey(item)
    const display = displaySize(item)
    const page = out.addPage([display.w, display.h])
    const doc = rasterKeys.has(key) ? null : await getDoc(item.srcId, src.bytes)

    if (!doc) {
      // Flattened fallback: render the page with pdf.js and place the image in
      // base space, so the user's rotation and annotations still line up.
      let img = rasters.get(key)
      if (!img) {
        const shot = await renderPageToJpeg(src.proxy, item.srcIndex, {
          scale: FALLBACK_SCALE,
          quality: 0.86,
          canvas: canvas ?? undefined,
        })
        img = await out.embedJpg(shot.bytes)
        rasters.set(key, img)
      }
      const placed = img
      await withLayer(page, item, () =>
        page.drawImage(placed, {
          x: 0,
          y: 0,
          width: item.baseWidth,
          height: item.baseHeight,
        }),
      )
    } else {
      let ep = embedded.get(key)
      if (!ep) {
        const srcPage = doc.getPage(item.srcIndex)
        // pdf-lib embeds by MediaBox but pdf.js measures pages by CropBox, so on
        // a cropped PDF the two disagree. Embed the CropBox to keep them in step.
        const crop = srcPage.getCropBox()
        ep = await out.embedPage(srcPage, {
          left: crop.x,
          bottom: crop.y,
          right: crop.x + crop.width,
          top: crop.y + crop.height,
        })
        embedded.set(key, ep)
      }

      // Total rotation = whatever the source page already declares + the user's.
      const intrinsic = doc.getPage(item.srcIndex).getRotation().angle
      const totalCw = (((intrinsic + item.rotate) % 360) + 360) % 360
      const swapped = totalCw % 180 === 90
      const w0 = swapped ? display.h : display.w
      const h0 = swapped ? display.w : display.h
      const place = rotationPlacement(totalCw, w0, h0)
      page.drawPage(ep, {
        x: place.tx,
        y: place.ty,
        width: w0,
        height: h0,
        rotate: degrees(place.ccw),
      })
    }

    const anns = annotations[item.id] ?? []
    if (anns.length) {
      await withLayer(page, item, async () => {
        for (const a of anns) {
          if (a.kind === 'text') {
            await drawText(page, a, item.baseHeight, fonts)
          } else if (a.kind === 'image') {
            const stored = images.get(a.imageId)
            if (!stored) continue
            let img = embeddedImages.get(a.imageId)
            if (!img) {
              img =
                stored.mime === 'image/png'
                  ? await out.embedPng(stored.bytes)
                  : await out.embedJpg(stored.bytes)
              embeddedImages.set(a.imageId, img)
            }
            page.drawImage(img, {
              x: a.x,
              y: item.baseHeight - (a.y + a.h),
              width: a.w,
              height: a.h,
              opacity: a.opacity,
            })
          } else {
            drawShape(page, a, item.baseHeight)
          }
        }
      })
    }

    opts.onProgress?.(i + 1, pages.length)
    // pdf-lib runs on the main thread; let the browser paint between pages so
    // the progress indicator stays alive on long documents.
    if (pages.length > 4) await yieldToBrowser()
  }

  if (opts.stripMetadata) {
    out.setTitle('')
    out.setAuthor('')
    out.setSubject('')
    out.setKeywords([])
    out.setProducer('')
    out.setCreator('')
  }

  if (canvas) {
    canvas.width = 0
    canvas.height = 0
  }
  return out.save(SAVE_OPTIONS)
}

/**
 * Finds source pages pdf-lib cannot copy. Some malformed structures only throw
 * at save time, when the page's content stream is finally written, so each page
 * is embedded into a throwaway document and saved in isolation.
 */
async function findUnembeddablePages(
  pages: PageItem[],
  sources: Map<string, SourceDoc>,
): Promise<Set<string>> {
  const bad = new Set<string>()
  const checked = new Set<string>()
  const docs = new Map<string, PDFDocument | null>()

  for (const item of pages) {
    const key = pageKey(item)
    if (checked.has(key)) continue
    checked.add(key)
    const src = sources.get(item.srcId)
    if (!src) continue

    if (!docs.has(item.srcId)) {
      try {
        docs.set(item.srcId, await PDFDocument.load(src.bytes, LOAD_OPTIONS))
      } catch {
        docs.set(item.srcId, null)
      }
    }
    const doc = docs.get(item.srcId)
    if (!doc) {
      bad.add(key)
      continue
    }

    try {
      const probe = await PDFDocument.create()
      const srcPage = doc.getPage(item.srcIndex)
      const crop = srcPage.getCropBox()
      const ep = await probe.embedPage(srcPage, {
        left: crop.x,
        bottom: crop.y,
        right: crop.x + crop.width,
        top: crop.y + crop.height,
      })
      const p = probe.addPage([Math.max(ep.width, 1), Math.max(ep.height, 1)])
      p.drawPage(ep)
      await probe.save(SAVE_OPTIONS)
    } catch {
      bad.add(key)
    }
  }
  return bad
}

/**
 * Rebuild a PDF from the working page list, stamping every annotation onto its
 * page. Source pages keep their vector content; only pages pdf-lib chokes on
 * are flattened to images, and the caller is told which ones.
 */
export async function buildPdf(
  pages: PageItem[],
  sources: Map<string, SourceDoc>,
  annotations: Record<string, Annotation[]>,
  images: Map<string, StoredImage>,
  opts: BuildOptions = {},
): Promise<Uint8Array> {
  // Pages already known to be unreadable by pdf-lib skip straight to the
  // fallback rather than making the whole export fail once and retry.
  const known = new Set(
    pages.filter((p) => sources.get(p.srcId)?.vectorOk === false).map(pageKey),
  )

  // A whiteout/redact box only actually removes what's underneath if the page
  // it sits on is flattened to a flat image before the box is drawn: otherwise
  // the original vector text stays in the file, fully intact and extractable,
  // with the box just painted on top of it. So any page carrying a redaction
  // goes through the same rasterised path as an unembeddable page.
  for (const item of pages) {
    const anns = annotations[item.id]
    if (anns?.some((a) => a.kind === 'rect' && a.redact)) known.add(pageKey(item))
  }

  try {
    return await assemble(pages, sources, annotations, images, opts, known)
  } catch (err) {
    const bad = await findUnembeddablePages(pages, sources)
    for (const k of known) bad.add(k)
    // The failure was not a per-page one, so there is nothing to work around.
    if (!bad.size) throw err

    opts.onFallback?.(
      pages
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => bad.has(pageKey(p)))
        .map(({ p, i }) => ({
          pageNumber: i + 1,
          fileName: sources.get(p.srcId)?.name ?? 'unknown file',
        })),
    )
    return await assemble(pages, sources, annotations, images, opts, bad)
  }
}

export function downloadBytes(bytes: Uint8Array, filename: string) {
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

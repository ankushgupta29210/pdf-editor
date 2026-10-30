import { zipSync, strToU8 } from 'fflate'
import { openWithPdfjs, pdfjsLib, type PDFDocumentProxy } from './pdfjs'
import { yieldToBrowser } from './limits'
import { sampleColours } from './textruns'

/**
 * PDF → Word / Excel / PowerPoint, entirely in the browser.
 *
 * PDFs store positioned glyphs, not paragraphs or tables, so every converter
 * here rebuilds structure from layout: text runs are grouped into lines by
 * baseline, lines into paragraphs by spacing and indentation, headings by
 * size, columns by the gutter between them, and table cells by the vertical
 * bands that text occupies. Images are pulled out of the page's drawing
 * operations with their positions. The Office files are written directly as
 * OOXML (zipped with fflate) — except slides, which use pptxgenjs.
 */

export interface ConvertProgress {
  page: number
  total: number
}

// ------------------------------------------------------------------ extract

type Family = 'sans' | 'serif' | 'mono'

export interface Run {
  text: string
  /** left edge, baseline and size in top-left page points */
  x: number
  y: number
  w: number
  size: number
  bold: boolean
  italic: boolean
  family: Family
}

export interface PageImage {
  x: number
  y: number
  w: number
  h: number
  png: Uint8Array
  /** pixel size of the PNG */
  pw: number
  ph: number
}

export interface PageContent {
  width: number
  height: number
  runs: Run[]
  images: PageImage[]
}

function styleFromName(name: string, family: string): { bold: boolean; italic: boolean; family: Family } {
  const n = `${name} ${family}`.toLowerCase()
  return {
    bold: /bold|black|heavy|semibold|demi/.test(n),
    italic: /italic|oblique/.test(n),
    family: /courier|mono|consol|menlo/.test(n)
      ? 'mono'
      : /sans/.test(n)
        ? 'sans'
        : /times|serif|georgia|garamond|cambria|minion|roman|palatino|book/.test(n)
          ? 'serif'
          : 'sans',
  }
}

type M6 = [number, number, number, number, number, number]
const mul = (m1: M6, m2: M6): M6 => [
  m1[0] * m2[0] + m1[1] * m2[2],
  m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2],
  m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
  m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
]

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!blob) throw new Error('Could not encode an image.')
  return new Uint8Array(await blob.arrayBuffer())
}

/** pdf.js image object → canvas. */
function imageToCanvas(img: {
  bitmap?: ImageBitmap
  width: number
  height: number
  kind?: number
  data?: Uint8ClampedArray | Uint8Array
}): HTMLCanvasElement | null {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  if (!ctx || !img.width || !img.height) return null
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0)
    return c
  }
  if (!img.data) return null
  const out = ctx.createImageData(img.width, img.height)
  const d = img.data
  const px = img.width * img.height
  if (img.kind === 3) out.data.set(d.subarray(0, px * 4))
  else if (img.kind === 2) {
    for (let i = 0, j = 0; i < px; i++, j += 3) {
      out.data[i * 4] = d[j]
      out.data[i * 4 + 1] = d[j + 1]
      out.data[i * 4 + 2] = d[j + 2]
      out.data[i * 4 + 3] = 255
    }
  } else if (img.kind === 1) {
    const rowBytes = (img.width + 7) >> 3
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const bit = (d[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const v = bit ? 255 : 0
        const o = (y * img.width + x) * 4
        out.data[o] = out.data[o + 1] = out.data[o + 2] = v
        out.data[o + 3] = 255
      }
    }
  } else return null
  ctx.putImageData(out, 0, 0)
  return c
}

/** Text runs and pictures of one page, in top-left page points. */
export async function extractPage(doc: PDFDocumentProxy, index: number, withImages: boolean): Promise<PageContent> {
  const lib = await pdfjsLib()
  const page = await doc.getPage(index + 1)
  const viewport = page.getViewport({ scale: 1 })
  const vt = viewport.transform as M6
  // The operator list makes pdf.js load fonts (for real names) and images.
  const ops = await page.getOperatorList()
  const content = await page.getTextContent()

  const runs: Run[] = []
  for (const it of content.items as Array<{ str: string; transform: number[]; width: number; fontName: string }>) {
    if (!('str' in it) || !it.str.trim()) continue
    const t = mul(it.transform as M6, vt)
    if (Math.abs(t[1]) > 0.01 * Math.abs(t[0]) || t[0] <= 0) continue // rotated text
    const size = Math.abs(t[3])
    if (size < 2) continue
    let real = ''
    try {
      if (page.commonObjs.has(it.fontName)) real = (page.commonObjs.get(it.fontName) as { name?: string })?.name ?? ''
    } catch {
      real = ''
    }
    const fam = (content.styles[it.fontName] as { fontFamily?: string } | undefined)?.fontFamily ?? ''
    runs.push({ text: it.str, x: t[4], y: t[5], w: it.width, size, ...styleFromName(real, fam) })
  }

  const images: PageImage[] = []
  if (withImages) {
    const OPS = lib.OPS
    let ctm: M6 = [1, 0, 0, 1, 0, 0]
    const stack: M6[] = []
    const seen = new Map<string, PageImage['png']>()
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i]
      const args = ops.argsArray[i] as unknown[]
      if (fn === OPS.save) stack.push(ctm)
      else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
      else if (fn === OPS.transform) ctm = mul(args as M6, ctm)
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm)
        const m = args[0] as number[] | null
        if (m && m.length === 6) ctm = mul(m as M6, ctm)
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        type ImgObj = Parameters<typeof imageToCanvas>[0]
        let img: ImgObj | null = null
        let id = ''
        try {
          if (fn === OPS.paintImageXObject) {
            id = args[0] as string
            img = (id.startsWith('g_') ? page.commonObjs.get(id) : page.objs.get(id)) as ImgObj
          } else img = args[0] as ImgObj
        } catch {
          img = null
        }
        if (!img) continue
        // The image fills the unit square under the current transform.
        const m = mul(ctm, vt)
        const corners = [
          [m[4], m[5]],
          [m[0] + m[4], m[1] + m[5]],
          [m[2] + m[4], m[3] + m[5]],
          [m[0] + m[2] + m[4], m[1] + m[3] + m[5]],
        ]
        const xs = corners.map((c) => c[0])
        const ys = corners.map((c) => c[1])
        const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
        if (box.w < 12 || box.h < 12) continue
        let png = id ? seen.get(id) : undefined
        let pw = img.width
        let ph = img.height
        if (!png) {
          const c = imageToCanvas(img)
          if (!c) continue
          // pdf.js images are stored top-down already in viewport orientation
          // for the usual (non-mirrored) placement.
          png = await canvasToPng(c)
          pw = c.width
          ph = c.height
          if (id) seen.set(id, png)
        }
        images.push({ ...box, png, pw, ph })
      }
    }
  }
  page.cleanup()
  return { width: viewport.width, height: viewport.height, runs, images }
}

// ------------------------------------------------------------------- layout

/**
 * Renders a page once and returns a function giving the ink colour of a text
 * line — the text layer pdf.js reports doesn't include colour.
 */
async function inkSampler(doc: PDFDocumentProxy, index: number) {
  const page = await doc.getPage(index + 1)
  const vp1 = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: 1.5 })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise
  return {
    ink(l: { x: number; y: number; w: number; size: number }) {
      return sampleColours(canvas, vp1.width, { x: l.x, y: l.y - l.size * 0.8, w: l.w, h: l.size }).ink.replace('#', '').toUpperCase()
    },
    dispose() {
      canvas.width = 0
      canvas.height = 0
    },
  }
}

export interface Line {
  /** ink colour as RRGGBB, filled in by converters that sample it */
  color?: string
  text: string
  x: number
  /** baseline */
  y: number
  w: number
  size: number
  bold: boolean
  italic: boolean
  family: Family
  /** spans in the line with their styles (for mixed bold/italic) */
  spans: Array<{ text: string; bold: boolean; italic: boolean; size: number; family: Family; color?: string }>
}

/** Groups runs into lines (same baseline, close together), left to right. */
export function toLines(runs: Run[], gapFactor = 1.2): Line[] {
  const sorted = [...runs].sort((a, b) => (Math.abs(a.y - b.y) < Math.max(1.5, a.size * 0.25) ? a.x - b.x : a.y - b.y))
  const lines: Line[] = []
  for (const r of sorted) {
    const last = lines.at(-1)
    const gap = last ? r.x - (last.x + last.w) : Infinity
    if (last && Math.abs(last.y - r.y) < Math.max(1.5, r.size * 0.25) && gap > -r.size && gap < r.size * gapFactor) {
      const space = gap > r.size * 0.15 && !last.text.endsWith(' ') && !r.text.startsWith(' ') ? ' ' : ''
      last.text += space + r.text
      last.w = Math.max(last.w, r.x + r.w - last.x)
      const prev = last.spans.at(-1)!
      if (prev.bold === r.bold && prev.italic === r.italic && Math.abs(prev.size - r.size) < 0.5 && prev.family === r.family) prev.text += space + r.text
      else last.spans.push({ text: space + r.text, bold: r.bold, italic: r.italic, size: r.size, family: r.family })
      last.size = Math.max(last.size, r.size)
    } else {
      lines.push({ ...r, spans: [{ text: r.text, bold: r.bold, italic: r.italic, size: r.size, family: r.family }] })
    }
  }
  return lines
}

/**
 * Puts a page's lines into reading order, handling two-column layouts: the
 * page is cut into vertical regions at every line that spans the gutter (a
 * title, a full-width figure caption…); inside a region with text on both
 * sides of the gutter, the left column is read before the right.
 * Returns groups of lines with the horizontal bounds of their column.
 */
function readingOrder(lines: Line[], width: number): Array<{ lines: Line[]; left: number; right: number }> {
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x)
  const pageL = sorted.length ? Math.min(...sorted.map((l) => l.x)) : 0
  const pageR = sorted.length ? Math.max(...sorted.map((l) => l.x + l.w)) : width
  const whole = [{ lines: sorted, left: pageL, right: pageR }]
  if (sorted.length < 6) return whole

  // The gutter: the x crossed by the fewest lines, among those not spanning
  // most of the page.
  const narrow = sorted.filter((l) => l.w < (pageR - pageL) * 0.62)
  let gutter = -1
  let fewest = Infinity
  for (let x = pageL + (pageR - pageL) * 0.3; x <= pageL + (pageR - pageL) * 0.7; x += 2) {
    const crossing = narrow.filter((l) => l.x < x - 1 && l.x + l.w > x + 1).length
    if (crossing < fewest) {
      fewest = crossing
      gutter = x
    }
  }
  // A few crossings are fine (a centred title, a caption): those lines split
  // the page into regions below. Many crossings means one column.
  if (gutter < 0 || fewest > Math.max(2, narrow.length * 0.15)) return whole

  const side = (l: Line) => (l.x + l.w <= gutter + 1 ? 'L' : l.x >= gutter - 1 ? 'R' : 'S')
  const out: Array<{ lines: Line[]; left: number; right: number }> = []
  let region: Line[] = []
  const flush = () => {
    if (!region.length) return
    const L = region.filter((l) => side(l) === 'L')
    const R = region.filter((l) => side(l) === 'R')
    // Two columns only if both sides have several lines that sit side by side.
    const overlap =
      L.length >= 2 &&
      R.length >= 2 &&
      Math.min(L.at(-1)!.y, R.at(-1)!.y) > Math.max(L[0].y, R[0].y)
    if (overlap) {
      out.push({ lines: L, left: Math.min(...L.map((l) => l.x)), right: Math.max(...L.map((l) => l.x + l.w)) })
      out.push({ lines: R, left: Math.min(...R.map((l) => l.x)), right: Math.max(...R.map((l) => l.x + l.w)) })
    } else out.push({ lines: region, left: pageL, right: pageR })
    region = []
  }
  for (const l of sorted) {
    if (side(l) === 'S') {
      flush()
      out.push({ lines: [l], left: pageL, right: pageR })
    } else region.push(l)
  }
  flush()
  // Merge neighbouring single-column groups back together so paragraphs that
  // were split by the regioning rejoin.
  const merged: typeof out = []
  for (const g of out) {
    const last = merged.at(-1)
    if (last && last.left === pageL && g.left === pageL && last.right === pageR && g.right === pageR) last.lines.push(...g.lines)
    else merged.push({ ...g, lines: [...g.lines] })
  }
  return merged
}

export interface Para {
  lines: Line[]
  align: 'left' | 'center' | 'right' | 'both'
  heading: 0 | 1 | 2 | 3
  /** space above, in points */
  before: number
  indent: number
  y: number
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Lines → paragraphs, with alignment, indentation and heading level. */
export function toParagraphs(lines: Line[], colLeft: number, colRight: number, bodySize: number): Para[] {
  const paras: Para[] = []
  const margin = colLeft
  const width = colRight - colLeft
  let prev: Line | null = null
  for (const l of lines) {
    const gap = prev ? l.y - prev.y : Infinity
    const lineH = Math.max(l.size, prev?.size ?? 0) * 1.25
    const sameStyle = prev && Math.abs(prev.size - l.size) < 0.6 && prev.bold === l.bold
    const continues =
      prev &&
      sameStyle &&
      gap > 0 &&
      gap < lineH * 1.45 &&
      Math.abs(l.x - paras.at(-1)!.lines[0].x) < l.size * 2.5 + (paras.at(-1)!.indent > 0 ? paras.at(-1)!.indent : 0)
    if (continues) {
      paras.at(-1)!.lines.push(l)
    } else {
      const center = l.x + l.w / 2
      const narrow = l.w < width * 0.75
      const align: Para['align'] =
        narrow && Math.abs(center - (colLeft + colRight) / 2) < width * 0.03 && l.x > margin + 20
          ? 'center'
          : narrow && Math.abs(l.x + l.w - colRight) < 6 && l.x > colLeft + width * 0.4
            ? 'right'
            : 'left'
      const ratio = l.size / (bodySize || l.size)
      const heading: Para['heading'] = ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : ratio >= 1.12 && l.bold ? 3 : 0
      paras.push({
        lines: [l],
        align,
        heading,
        before: prev ? Math.max(0, gap - lineH) : 0,
        indent: Math.max(0, l.x - margin),
        y: l.y,
      })
    }
    prev = l
  }
  // Justified paragraphs: several lines that all reach the right edge.
  for (const p of paras) {
    if (p.lines.length >= 3 && p.align === 'left') {
      const rights = p.lines.slice(0, -1).map((l) => l.x + l.w)
      if (Math.max(...rights) - Math.min(...rights) < 3) p.align = 'both'
    }
  }
  return paras
}

// --------------------------------------------------------------------- DOCX

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')

const FONT: Record<Family, string> = { sans: 'Arial', serif: 'Times New Roman', mono: 'Courier New' }

export interface WordOptions {
  /** 'editable' rebuilds text; 'exact' places each page as a picture */
  mode: 'editable' | 'exact'
  images: boolean
  onProgress?: (p: ConvertProgress) => void
}

const EMU = 12700 // per point

function drawingXml(rel: string, id: number, wPt: number, hPt: number): string {
  const cx = Math.round(wPt * EMU)
  const cy = Math.round(hPt * EMU)
  return (
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  )
}

function runXml(span: Line['spans'][number], bodyFamily: Family): string {
  const props = [
    span.family !== bodyFamily ? `<w:rFonts w:ascii="${FONT[span.family]}" w:hAnsi="${FONT[span.family]}" w:cs="${FONT[span.family]}"/>` : '',
    span.bold ? '<w:b/>' : '',
    span.italic ? '<w:i/>' : '',
    span.color && span.color !== '000000' ? `<w:color w:val="${span.color}"/>` : '',
    `<w:sz w:val="${Math.max(2, Math.round(span.size * 2))}"/>`,
  ].join('')
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(span.text)}</w:t></w:r>`
}

/** Renders a page of `doc` to PNG at `dpi`. */
async function pagePng(doc: PDFDocumentProxy, index: number, dpi: number, hideText = false): Promise<{ png: Uint8Array; w: number; h: number }> {
  const page = await doc.getPage(index + 1)
  const viewport = page.getViewport({ scale: dpi / 72 })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (hideText) {
    // Text becomes editable boxes on top, so leave it off the background:
    // pdf.js draws glyphs with fillText/strokeText (except Type3 fonts).
    ctx.fillText = () => undefined
    ctx.strokeText = () => undefined
  }
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise
  const png = await canvasToPng(canvas)
  page.cleanup()
  const out = { png, w: canvas.width, h: canvas.height }
  canvas.width = 0
  canvas.height = 0
  return out
}

export async function pdfToWord(bytes: Uint8Array, opts: WordOptions): Promise<Uint8Array> {
  const doc = await openWithPdfjs(bytes)
  try {
    const files: Record<string, Uint8Array> = {}
    const rels: string[] = []
    let relId = 10
    let picId = 1
    const body: string[] = []
    let firstSize = { w: 612, h: 792 }

    // Body text size = the most common size across the document.
    const contents: PageContent[] = []
    for (let i = 0; i < doc.numPages; i++) {
      opts.onProgress?.({ page: i + 1, total: doc.numPages })
      if (opts.mode === 'exact') {
        const page = await doc.getPage(i + 1)
        const vp = page.getViewport({ scale: 1 })
        contents.push({ width: vp.width, height: vp.height, runs: [], images: [] })
      } else contents.push(await extractPage(doc, i, opts.images))
      await yieldToBrowser()
    }
    firstSize = { w: contents[0]?.width ?? 612, h: contents[0]?.height ?? 792 }
    const sizes = contents.flatMap((c) => c.runs.map((r) => Math.round(r.size * 2) / 2))
    const bodySize = median(sizes) || 11
    const fams = contents.flatMap((c) => c.runs.map((r) => r.family))
    const bodyFamily: Family = (['serif', 'sans', 'mono'] as Family[]).reduce((a, b) =>
      fams.filter((f) => f === b).length > fams.filter((f) => f === a).length ? b : a,
    )

    const addImage = (png: Uint8Array, wPt: number, hPt: number) => {
      const name = `media/image${picId}.png`
      files[`word/${name}`] = png
      const rel = `rId${relId++}`
      rels.push(`<Relationship Id="${rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${name}"/>`)
      const xml = drawingXml(rel, picId++, wPt, hPt)
      return xml
    }

    let margins = { l: 72, r: 72, t: 72, b: 72 }
    for (const [i, c] of contents.entries()) {
      if (i > 0) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
      if (opts.mode === 'exact') {
        opts.onProgress?.({ page: i + 1, total: contents.length })
        const shot = await pagePng(doc, i, 150)
        body.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r>${addImage(shot.png, c.width, c.height)}</w:r></w:p>`)
        margins = { l: 0, r: 0, t: 0, b: 0 }
        continue
      }
      const lines = toLines(c.runs)
      if (lines.length) {
        const sampler = await inkSampler(doc, i)
        for (const l of lines) {
          const color = sampler.ink(l)
          l.color = color
          for (const sp of l.spans) sp.color = color
        }
        sampler.dispose()
      }
      if (i === 0 && lines.length) {
        const minX = Math.min(...lines.map((l) => l.x))
        const maxX = Math.max(...lines.map((l) => l.x + l.w))
        const minY = Math.min(...lines.map((l) => l.y - l.size))
        margins = {
          l: Math.max(18, Math.min(108, minX)),
          r: Math.max(18, Math.min(108, c.width - maxX)),
          t: Math.max(18, Math.min(108, minY)),
          b: 54,
        }
      }
      // Paragraphs and images, interleaved top to bottom.
      const blocks: Array<{ y: number; xml: string }> = []
      for (const [gi, group] of readingOrder(lines, c.width).entries()) {
        const paras = toParagraphs(group.lines, group.left, group.right, bodySize)
        // A new column (or region) starts a fresh paragraph with some air.
        if (gi > 0 && paras[0]) paras[0].before = Math.max(paras[0].before, bodySize * 0.6)
        for (const p of paras) {
          const style = p.heading ? `<w:pStyle w:val="Heading${p.heading}"/>` : ''
          const jc = p.align !== 'left' ? `<w:jc w:val="${p.align}"/>` : ''
          const ind = p.indent > 6 && p.align === 'left' ? `<w:ind w:left="${Math.round(Math.min(p.indent, 300) * 20)}"/>` : ''
          const spacing = `<w:spacing w:before="${Math.round(Math.min(p.before, 40) * 20)}" w:after="0"/>`
          // Lines of one paragraph rejoin into flowing text (hyphenated breaks merge).
          const spans: Line['spans'] = []
          p.lines.forEach((l, k) => {
            l.spans.forEach((s, j) => {
              let text = s.text
              if (k > 0 && j === 0) {
                const prevSpan = spans.at(-1)
                if (prevSpan && /[A-Za-z]-$/.test(prevSpan.text)) prevSpan.text = prevSpan.text.slice(0, -1)
                else text = ' ' + text.trimStart()
              }
              spans.push({ ...s, text })
            })
          })
          const runs = spans.map((s) => runXml(s, bodyFamily)).join('')
          blocks.push({ y: p.y, xml: `<w:p><w:pPr>${style}${spacing}${ind}${jc}</w:pPr>${runs}</w:p>` })
        }
      }
      if (opts.images) {
        const usable = c.width - margins.l - margins.r
        for (const im of c.images) {
          const scale = Math.min(1, usable / im.w)
          blocks.push({
            y: im.y + im.h,
            xml: `<w:p><w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr><w:r>${addImage(im.png, im.w * scale, im.h * scale)}</w:r></w:p>`,
          })
        }
      }
      // Text keeps its reading order; pictures slot in before the first block
      // that starts below them.
      const textBlocks = blocks.filter((b) => !b.xml.includes('<w:drawing>'))
      const picBlocks = blocks.filter((b) => b.xml.includes('<w:drawing>')).sort((a, b) => a.y - b.y)
      const ordered: string[] = []
      for (const t of textBlocks) {
        while (picBlocks.length && picBlocks[0].y <= t.y) ordered.push(picBlocks.shift()!.xml)
        ordered.push(t.xml)
      }
      ordered.push(...picBlocks.map((p) => p.xml))
      body.push(...ordered)
    }

    const tw = (pt: number) => Math.round(pt * 20)
    const sect =
      `<w:sectPr><w:pgSz w:w="${tw(firstSize.w)}" w:h="${tw(firstSize.h)}"${firstSize.w > firstSize.h ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${tw(margins.t)}" w:right="${tw(margins.r)}" w:bottom="${tw(margins.b)}" w:left="${tw(margins.l)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`

    const NS =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
    files['word/document.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body.join('')}${sect}</w:body></w:document>`,
    )
    const hd = (n: number, mult: number) =>
      `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
      `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${Math.round(bodySize * mult * 2)}"/></w:rPr></w:style>`
    files['word/styles.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT[bodyFamily]}" w:hAnsi="${FONT[bodyFamily]}" w:cs="${FONT[bodyFamily]}" w:eastAsia="${FONT[bodyFamily]}"/>` +
        `<w:sz w:val="${Math.round(bodySize * 2)}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
        `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
        hd(1, 1.8) + hd(2, 1.45) + hd(3, 1.2) +
        `</w:styles>`,
    )
    files['word/_rels/document.xml.rels'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels.join('')}</Relationships>`,
    )
    files['_rels/.rels'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    )
    files['[Content_Types].xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    )
    return zipSync(files, { level: 6 })
  } finally {
    void doc.destroy()
  }
}

// -------------------------------------------------------------------- XLSX

export interface ExcelOptions {
  sheets: 'perPage' | 'single'
  onProgress?: (p: ConvertProgress) => void
}

type Cell = { v: string; bold: boolean } | null

/** "1,250.00" / "$3.50" / "(120)" / "12%" → number, else null. */
export function parseNumber(s: string): { value: number; format: string | null } | null {
  const t = s.trim()
  if (!t || t.length > 24) return null
  const pct = /%$/.test(t)
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t)
  const cur = /[$€£¥₹]/.exec(t)?.[0] ?? ''
  const core = t.replace(/^[(-]/, '').replace(/[)%]$/, '').replace(/^[$€£¥₹]\s?/, '').replace(/\s?[$€£¥₹]$/, '')
  if (!/^\d{1,3}(,\d{3})+(\.\d+)?$|^\d+(\.\d+)?$/.test(core)) return null
  let v = Number(core.replace(/,/g, ''))
  if (!Number.isFinite(v)) return null
  if (neg) v = -v
  const decimals = core.includes('.') ? core.split('.')[1].length : 0
  const grouped = core.includes(',')
  if (pct) return { value: v / 100, format: decimals ? `0.${'0'.repeat(decimals)}%` : '0%' }
  const base = (grouped || cur ? '#,##0' : '0') + (decimals ? '.' + '0'.repeat(decimals) : '')
  const withCur = cur ? `"${cur}"${base}` : base
  // Brackets mean negative in accounts: keep showing them that way.
  const fmt = /^\(.*\)$/.test(t) ? `${withCur};(${withCur})` : withCur
  return { value: v, format: decimals || grouped || cur ? fmt : null }
}

/** One page of runs → a grid of cells using the columns text occupies. */
export function pageToGrid(c: PageContent): Cell[][] {
  // Cells: runs on one baseline separated by a real gap become separate cells.
  const cells = toLines(c.runs, 0.9)
  if (!cells.length) return []
  // Column bands: merge the horizontal extents of all cells that overlap.
  const spans = cells.map((l) => [l.x, l.x + l.w] as [number, number]).sort((a, b) => a[0] - b[0])
  const bands: Array<[number, number]> = []
  for (const s of spans) {
    const last = bands.at(-1)
    if (last && s[0] <= last[1] + 2) last[1] = Math.max(last[1], s[1])
    else bands.push([...s])
  }
  // Rows: cells sharing a baseline (within a fraction of the text size).
  const rows: Line[][] = []
  for (const l of [...cells].sort((a, b) => a.y - b.y)) {
    const row = rows.at(-1)
    if (row && Math.abs(row[0].y - l.y) < Math.max(2, l.size * 0.5)) row.push(l)
    else rows.push([l])
  }
  return rows.map((row) => {
    const out: Cell[] = new Array(bands.length).fill(null)
    for (const l of row) {
      const col = bands.findIndex((b) => l.x >= b[0] - 0.5 && l.x <= b[1])
      const k = col < 0 ? 0 : col
      const prev = out[k]
      out[k] = prev === null ? { v: l.text, bold: l.bold } : { v: `${prev.v} ${l.text}`, bold: prev.bold && l.bold }
    }
    return out
  })
}

function colName(i: number): string {
  let s = ''
  i++
  while (i > 0) {
    const m = (i - 1) % 26
    s = String.fromCharCode(65 + m) + s
    i = Math.floor((i - 1) / 26)
  }
  return s
}

export async function pdfToExcel(bytes: Uint8Array, opts: ExcelOptions): Promise<Uint8Array> {
  const doc = await openWithPdfjs(bytes)
  try {
    const grids: Cell[][][] = []
    for (let i = 0; i < doc.numPages; i++) {
      opts.onProgress?.({ page: i + 1, total: doc.numPages })
      grids.push(pageToGrid(await extractPage(doc, i, false)))
      await yieldToBrowser()
    }
    const sheets: Cell[][][] =
      opts.sheets === 'single' ? [grids.flatMap((g, i) => (i ? [[] as Cell[], ...g] : g))] : grids.length ? grids : [[]]

    const formats: string[] = []
    /** cell styles: [number format id, bold] — index 0 is the default */
    const xfs: Array<[number, boolean]> = [[0, false]]
    const styleFor = (fmt: string | null, bold: boolean) => {
      let numFmt = 0
      if (fmt) {
        let i = formats.indexOf(fmt)
        if (i < 0) {
          formats.push(fmt)
          i = formats.length - 1
        }
        numFmt = 164 + i
      }
      let x = xfs.findIndex(([n, b]) => n === numFmt && b === bold)
      if (x < 0) {
        xfs.push([numFmt, bold])
        x = xfs.length - 1
      }
      return x
    }

    const files: Record<string, Uint8Array> = {}
    const sheetXml = (rows: Cell[][]) => {
      const widths: number[] = []
      const rowXml = rows
        .map((row, r) => {
          const cellsXml = row
            .map((cell, c) => {
              if (cell === null || cell.v === '') return ''
              const ref = `${colName(c)}${r + 1}`
              const text = cell.v
              widths[c] = Math.max(widths[c] ?? 0, Math.min(60, text.length + 2))
              const n = parseNumber(text)
              const st = styleFor(n?.format ?? null, cell.bold)
              const sAttr = st ? ` s="${st}"` : ''
              if (n) return `<c r="${ref}"${sAttr}><v>${n.value}</v></c>`
              return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`
            })
            .join('')
          return `<row r="${r + 1}">${cellsXml}</row>`
        })
        .join('')
      const cols = widths.length
        ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, w ?? 8)}" customWidth="1"/>`).join('')}</cols>`
        : ''
      return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `${cols}<sheetData>${rowXml}</sheetData></worksheet>`
      )
    }
    sheets.forEach((rows, i) => {
      files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(rows))
    })
    const names = sheets.map((_, i) => (opts.sheets === 'single' ? 'Document' : `Page ${i + 1}`))
    files['xl/workbook.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        `</sheets></workbook>`,
    )
    files['xl/_rels/workbook.xml.rels'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        names
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join('') +
        `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    )
    files['xl/styles.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        (formats.length
          ? `<numFmts count="${formats.length}">${formats.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join('')}</numFmts>`
          : '') +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="${xfs.length}">` +
        xfs
          .map(
            ([n, b]) =>
              `<xf numFmtId="${n}" fontId="${b ? 1 : 0}" fillId="0" borderId="0" xfId="0"${n ? ' applyNumberFormat="1"' : ''}${b ? ' applyFont="1"' : ''}/>`,
          )
          .join('') +
        `</cellXfs></styleSheet>`,
    )
    files['_rels/.rels'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    )
    files['[Content_Types].xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        `</Types>`,
    )
    return zipSync(files, { level: 6 })
  } finally {
    void doc.destroy()
  }
}

// -------------------------------------------------------------------- PPTX

export interface SlidesOptions {
  /** 'editable' puts the text in real text boxes over a text-free picture */
  mode: 'editable' | 'pictures'
  onProgress?: (p: ConvertProgress) => void
}

export async function pdfToPowerPoint(bytes: Uint8Array, opts: SlidesOptions): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const doc = await openWithPdfjs(bytes)
  try {
    const first = await doc.getPage(1)
    const vp = first.getViewport({ scale: 1 })
    const pptx = new PptxGenJS()
    // Slide size follows the first page (inches = points / 72).
    pptx.defineLayout({ name: 'PDF', width: vp.width / 72, height: vp.height / 72 })
    pptx.layout = 'PDF'
    for (let i = 0; i < doc.numPages; i++) {
      opts.onProgress?.({ page: i + 1, total: doc.numPages })
      const page = await doc.getPage(i + 1)
      const pv = page.getViewport({ scale: 1 })
      const sx = vp.width / pv.width
      const sy = vp.height / pv.height
      const slide = pptx.addSlide()
      const shot = await pagePng(doc, i, 160, opts.mode === 'editable')
      let b64 = ''
      for (let k = 0; k < shot.png.length; k += 0x8000) b64 += String.fromCharCode(...shot.png.subarray(k, k + 0x8000))
      slide.background = { data: `image/png;base64,${btoa(b64)}` }
      if (opts.mode === 'editable') {
        const content = await extractPage(doc, i, false)
        const sampler = await inkSampler(doc, i)
        for (const l of toLines(content.runs, 0.9)) {
          const size = l.size * sy
          const color = sampler.ink(l)
          slide.addText(
            l.spans.map((s) => ({
              text: s.text,
              options: { bold: s.bold, italic: s.italic, fontSize: s.size * sy, fontFace: FONT[s.family] },
            })),
            {
              x: (l.x * sx) / 72,
              y: ((l.y - l.size * 0.92) * sy) / 72,
              w: ((l.w + l.size) * sx) / 72,
              h: (size * 1.2) / 72,
              margin: 0,
              valign: 'top',
              color,
              fit: 'none',
              wrap: false,
            },
          )
        }
        sampler.dispose()
      }
      await yieldToBrowser()
    }
    const out = (await pptx.write({ outputType: 'uint8array' })) as Uint8Array
    return out
  } finally {
    void doc.destroy()
  }
}

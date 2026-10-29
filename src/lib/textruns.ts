import type { PDFDocumentProxy } from './pdfjs'
import type { FontKey } from './types'

/** One line of existing page text, in base space (top-left origin, points). */
export interface TextLine {
  text: string
  x: number
  /** y of the baseline */
  baseline: number
  w: number
  fontSize: number
  font: FontKey
  bold: boolean
  italic: boolean
}

interface RawItem {
  str: string
  transform: number[]
  width: number
  height: number
  fontName: string
  hasEOL?: boolean
}

const cache = new Map<string, Promise<TextLine[]>>()

function guessFont(name: string, family: string): { font: FontKey; bold: boolean; italic: boolean } {
  const n = `${name} ${family}`.toLowerCase()
  const font: FontKey = /courier|mono|consol|menlo|typewriter/.test(n)
    ? 'Courier'
    : /times|serif(?!.*sans)|georgia|garamond|cambria|minion|book|roman|palatino/.test(n) &&
        !/sans/.test(n)
      ? 'Times'
      : 'Helvetica'
  return {
    font,
    bold: /bold|black|heavy|semibold|demi/.test(n),
    italic: /italic|oblique/.test(n),
  }
}

/**
 * Groups the page's text into editable lines. pdf.js reports text in small
 * runs (often a word or less), so neighbouring runs on the same baseline with
 * the same size are merged; anything rotated or skewed is skipped.
 */
export function readTextLines(
  proxy: PDFDocumentProxy,
  srcId: string,
  pageIndex: number,
): Promise<TextLine[]> {
  const key = `${srcId}:${pageIndex}`
  let hit = cache.get(key)
  if (!hit) {
    hit = (async () => {
      const page = await proxy.getPage(pageIndex + 1)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const [va, vb, vc, vd, ve, vf] = viewport.transform as number[]
      const runs: TextLine[] = []
      for (const raw of content.items as RawItem[]) {
        if (!('str' in raw) || !raw.str.trim()) continue
        const [a, b, c, d, e, f] = raw.transform
        // Item transform composed with the viewport transform → top-left space.
        const ta = va * a + vc * b
        const tb = vb * a + vd * b
        const tc = va * c + vc * d
        const td = vb * c + vd * d
        const tx = va * e + vc * f + ve
        const ty = vb * e + vd * f + vf
        // Only plain horizontal text can be matched by an upright text box.
        if (Math.abs(tb) > 0.01 * Math.abs(ta) || Math.abs(tc) > 0.01 * Math.abs(td) || ta <= 0) continue
        const fontSize = Math.abs(td)
        if (fontSize < 3) continue
        const style = content.styles[raw.fontName] as { fontFamily?: string } | undefined
        let realName = ''
        try {
          // The embedded font's PostScript name (e.g. "ABCDEF+Calibri-Bold") is
          // available once pdf.js has loaded the font for rendering.
          if (page.commonObjs.has(raw.fontName)) {
            realName = (page.commonObjs.get(raw.fontName) as { name?: string })?.name ?? ''
          }
        } catch {
          realName = ''
        }
        // getTextContent reports widths in page units; the viewport is scale 1.
        const width = raw.width
        runs.push({
          text: raw.str,
          x: tx,
          baseline: ty,
          w: width,
          fontSize,
          ...guessFont(realName, style?.fontFamily ?? ''),
        })
      }

      // Merge runs that continue the same line.
      runs.sort((p, q) => (Math.abs(p.baseline - q.baseline) < 1.5 ? p.x - q.x : p.baseline - q.baseline))
      const lines: TextLine[] = []
      for (const r of runs) {
        const last = lines.at(-1)
        const gap = last ? r.x - (last.x + last.w) : Infinity
        if (
          last &&
          Math.abs(last.baseline - r.baseline) < Math.max(1.5, r.fontSize * 0.15) &&
          Math.abs(last.fontSize - r.fontSize) < 0.6 &&
          gap > -r.fontSize * 0.5 &&
          gap < r.fontSize * 1.2
        ) {
          const needsSpace = gap > r.fontSize * 0.15 && !last.text.endsWith(' ') && !r.text.startsWith(' ')
          last.text += (needsSpace ? ' ' : '') + r.text
          last.w = r.x + r.w - last.x
        } else {
          lines.push({ ...r })
        }
      }
      return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text)
    })().catch(() => [])
    cache.set(key, hit)
  }
  return hit
}

/**
 * Samples the rendered page to find the paper colour around a line and the ink
 * colour of its glyphs, so the cover patch and the replacement text blend in.
 */
export function sampleColours(
  canvas: HTMLCanvasElement,
  baseWidth: number,
  box: { x: number; y: number; w: number; h: number },
): { background: string; ink: string } {
  const fallback = { background: '#ffffff', ink: '#000000' }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx || !canvas.width) return fallback
  const k = canvas.width / baseWidth
  const x0 = Math.max(0, Math.floor(box.x * k))
  const y0 = Math.max(0, Math.floor(box.y * k))
  const w = Math.min(canvas.width - x0, Math.ceil(box.w * k))
  const h = Math.min(canvas.height - y0, Math.ceil(box.h * k))
  if (w < 2 || h < 2) return fallback
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(x0, y0, w, h).data
  } catch {
    return fallback
  }
  // Background: the most common colour (quantised) in the box — glyphs only
  // cover a minority of the pixels in a line box.
  const counts = new Map<number, number>()
  let darkest = { lum: 999, r: 0, g: 0, b: 0 }
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const q = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    counts.set(q, (counts.get(q) ?? 0) + 1)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (lum < darkest.lum) darkest = { lum, r, g, b }
  }
  let best = 0
  let bestN = -1
  for (const [q, n] of counts) {
    if (n > bestN) {
      best = q
      bestN = n
    }
  }
  const hex = (r: number, g: number, b: number) =>
    '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
  const bg = hex(((best >> 10) & 31) * 8 + 4, ((best >> 5) & 31) * 8 + 4, (best & 31) * 8 + 4)
  // Snap near-white paper to pure white so the patch is invisible on export.
  const background = /^#f[89a-f]f[89a-f]f[89a-f]$/i.test(bg) ? '#ffffff' : bg
  // Anti-aliased glyph pixels are lighter than the true ink; the darkest pixel
  // is the closest estimate. Near-black is treated as black.
  const ink =
    Math.max(darkest.r, darkest.g, darkest.b) < 45 ? '#000000' : hex(darkest.r, darkest.g, darkest.b)
  return { background, ink }
}

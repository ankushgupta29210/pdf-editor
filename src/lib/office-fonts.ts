/**
 * Fonts for Word/Excel/PowerPoint → PDF.
 *
 * Office documents name fonts that a browser usually doesn't have (Calibri,
 * Cambria, Arial on Linux…). Each one is mapped to a free, *metric-compatible*
 * face — Carlito for Calibri, Caladea for Cambria, Arimo for Arial, Tinos for
 * Times New Roman, Cousine for Courier New — so lines break where they do in
 * Office. The same files are used twice: the browser lays the document out
 * with them, and they are embedded (subset) in the PDF, so every word lands
 * exactly where the browser put it.
 *
 * The faces come split into script subsets (latin, cyrillic, greek…), loaded
 * only when a document actually uses them. Characters none of them cover
 * (Chinese, Arabic, Devanagari…) are drawn by the caller as a picture with an
 * invisible text layer on top, so they still look right and stay searchable.
 */
import type { PDFDocument, PDFFont } from 'pdf-lib'
import arimoRanges from '@fontsource/arimo/unicode.json'
import tinosRanges from '@fontsource/tinos/unicode.json'
import cousineRanges from '@fontsource/cousine/unicode.json'
import carlitoRanges from '@fontsource/carlito/unicode.json'
import caladeaRanges from '@fontsource/caladea/unicode.json'

export type FamilyKey = 'sans' | 'serif' | 'mono' | 'calibri' | 'cambria'

const glob = {
  sans: import.meta.glob('../../node_modules/@fontsource/arimo/files/*-{400,700}-{normal,italic}.woff', {
    query: '?url',
    import: 'default',
    eager: true,
  }),
  serif: import.meta.glob('../../node_modules/@fontsource/tinos/files/*-{400,700}-{normal,italic}.woff', {
    query: '?url',
    import: 'default',
    eager: true,
  }),
  mono: import.meta.glob('../../node_modules/@fontsource/cousine/files/*-{400,700}-{normal,italic}.woff', {
    query: '?url',
    import: 'default',
    eager: true,
  }),
  calibri: import.meta.glob('../../node_modules/@fontsource/carlito/files/*-{400,700}-{normal,italic}.woff', {
    query: '?url',
    import: 'default',
    eager: true,
  }),
  cambria: import.meta.glob('../../node_modules/@fontsource/caladea/files/*-{400,700}-{normal,italic}.woff', {
    query: '?url',
    import: 'default',
    eager: true,
  }),
} as Record<FamilyKey, Record<string, string>>

const RANGES: Record<FamilyKey, Record<string, string>> = {
  sans: arimoRanges,
  serif: tinosRanges,
  mono: cousineRanges,
  calibri: carlitoRanges,
  cambria: caladeaRanges,
}

/** Subsets in the order they are tried for a character. */
const SUBSET_ORDER = ['latin', 'latin-ext', 'vietnamese', 'greek', 'greek-ext', 'cyrillic', 'cyrillic-ext', 'hebrew']

interface Face {
  family: FamilyKey
  subset: string
  bold: boolean
  italic: boolean
  url: string
  ranges: Array<[number, number]>
}

function parseRanges(spec: string): Array<[number, number]> {
  return spec.split(',').map((part) => {
    const [a, b] = part.trim().replace(/^U\+/i, '').split('-')
    const lo = parseInt(a, 16)
    return [lo, b ? parseInt(b, 16) : lo] as [number, number]
  })
}

let faces: Face[] | null = null
function allFaces(): Face[] {
  if (faces) return faces
  faces = []
  for (const family of Object.keys(glob) as FamilyKey[]) {
    for (const [path, url] of Object.entries(glob[family])) {
      const m = /\/[a-z]+-([a-z-]+)-(400|700)-(normal|italic)\.woff$/.exec(path)
      if (!m) continue
      const spec = RANGES[family][m[1]]
      if (!spec) continue
      faces.push({
        family,
        subset: m[1],
        bold: m[2] === '700',
        italic: m[3] === 'italic',
        url,
        ranges: parseRanges(spec),
      })
    }
  }
  return faces
}

function faceFor(cp: number, family: FamilyKey, bold: boolean, italic: boolean): Face | null {
  const list = allFaces().filter((f) => f.family === family && f.bold === bold && f.italic === italic)
  for (const subset of SUBSET_ORDER) {
    const f = list.find((x) => x.subset === subset)
    if (f && f.ranges.some(([a, b]) => cp >= a && cp <= b)) return f
  }
  return null
}

/** Whether a bundled face can draw this character (spaces always can). */
export function isCovered(ch: string, family: FamilyKey, bold: boolean, italic: boolean): boolean {
  const cp = ch.codePointAt(0)!
  if (cp === 0x20 || cp === 0xa0 || cp === 0x09) return true
  return faceFor(cp, family, bold, italic) !== null
}

export const cssFamily = (key: FamilyKey) => `pe-${key}`

/** CSS font-family value for a mapped face, with system fallbacks for scripts
 *  the bundled fonts don't cover. */
export function cssStack(key: FamilyKey): string {
  const generic = key === 'serif' || key === 'cambria' ? 'serif' : key === 'mono' ? 'monospace' : 'sans-serif'
  return `${cssFamily(key)}, ${generic}`
}

let registered = false
/** Makes the faces available to the page's layout (each file is fetched only
 *  if text in that script and style is actually laid out). */
export function registerOfficeFonts() {
  if (registered) return
  registered = true
  for (const f of allFaces()) {
    const face = new FontFace(cssFamily(f.family), `url(${f.url}) format('woff')`, {
      weight: f.bold ? '700' : '400',
      style: f.italic ? 'italic' : 'normal',
      unicodeRange: f.ranges.map(([a, b]) => (a === b ? `U+${a.toString(16)}` : `U+${a.toString(16)}-${b.toString(16)}`)).join(','),
    })
    document.fonts.add(face)
  }
}

/** Office font name (or a CSS family list) → the bundled face family. */
export function mapFamily(name: string): FamilyKey {
  const first = name.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase()
  if (first.startsWith('pe-')) {
    const k = first.slice(3) as FamilyKey
    if (k in glob) return k
  }
  if (/calibri|aptos|candara|corbel|carlito|gill sans|tw cen|century gothic|lato|open sans|source sans|noto sans|roboto|helvetica neue|avenir|franklin/.test(first))
    return 'calibri'
  if (/cambria|caladea|constantia|book antiqua|palatino|garamond|baskerville|didot|bodoni/.test(first)) return 'cambria'
  if (/courier|consolas|mono|menlo|monaco|lucida console|lucida sans typewriter|cousine|source code|fira code|cascadia/.test(first))
    return 'mono'
  if (/times|tinos|georgia|serif|minion|bookman|century schoolbook|liberation serif|charter|cambria math|mincho|song|batang|ming/.test(first))
    return /sans/.test(first) ? 'sans' : 'serif'
  return 'sans'
}

/** Symbol/Wingdings code points → the Unicode characters they draw. Bullets in
 *  Office files are usually these. */
const SYMBOL_MAP: Record<number, string> = {
  0xb7: '•',
  0xa7: '▪',
  0xa8: '◆',
  0xd8: '➢',
  0xfc: '✓',
  0xfb: '✗',
  0x76: '❖',
  0x71: '❑',
  0x6e: '■',
  0x6c: '●',
  0x6f: '○',
  0xa1: '○',
  0x77: '◆',
  0xe0: '➔',
  0xe8: '➔',
  0xf0: '⇨',
  0x2d: '–',
  0x3e: '>',
  0x2022: '•',
}
const SYMBOL_FONTS = /symbol|wingdings|webdings|marlett/i

/** Turns private-use / symbol-font characters into real Unicode ones. */
export function mapSymbolText(text: string, fontName: string): string {
  const symbolFont = SYMBOL_FONTS.test(fontName)
  let out = ''
  for (const ch of text) {
    let cp = ch.codePointAt(0)!
    if (cp >= 0xf000 && cp <= 0xf0ff) cp -= 0xf000
    else if (!symbolFont) {
      out += ch
      continue
    }
    const mapped = SYMBOL_MAP[cp]
    out += mapped ?? (cp < 0x20 ? '' : symbolFont ? '•' : String.fromCodePoint(cp))
  }
  return out
}

export interface FontPart {
  text: string
  /** null → no bundled face covers these characters */
  font: PDFFont | null
  /** baseline position within the line box, 0..1 from the top (for faces) */
  start: number
}

/**
 * Per-document cache of embedded faces. `split` cuts a string into runs, each
 * drawable with one embedded font (or with none, when nothing covers it).
 */
export class OfficeFontSet {
  private embedded = new Map<Face, Promise<PDFFont | null>>()
  private bytes = new Map<string, Promise<ArrayBuffer>>()

  constructor(private doc: PDFDocument) {}

  private embed(face: Face): Promise<PDFFont | null> {
    let p = this.embedded.get(face)
    if (!p) {
      p = (async () => {
        try {
          let buf = this.bytes.get(face.url)
          if (!buf) {
            buf = fetch(face.url).then((r) => {
              if (!r.ok) throw new Error(String(r.status))
              return r.arrayBuffer()
            })
            this.bytes.set(face.url, buf)
          }
          return await this.doc.embedFont(new Uint8Array(await buf), {
            subset: true,
            features: { liga: false, clig: false, dlig: false, kern: false, calt: false },
          })
        } catch {
          return null
        }
      })()
      this.embedded.set(face, p)
    }
    return p
  }

  async split(text: string, family: FamilyKey, bold: boolean, italic: boolean): Promise<FontPart[]> {
    const parts: Array<{ text: string; face: Face | null; start: number }> = []
    let i = 0
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      // Spaces join whatever run they are in.
      const face = cp === 0x20 || cp === 0xa0 ? (parts.at(-1)?.face ?? faceFor(cp, family, bold, italic)) : faceFor(cp, family, bold, italic)
      const last = parts.at(-1)
      if (last && last.face === face) last.text += ch
      else parts.push({ text: ch, face, start: i })
      i += ch.length
    }
    const out: FontPart[] = []
    for (const p of parts) {
      const font = p.face ? await this.embed(p.face) : null
      out.push({ text: p.text, font, start: p.start })
    }
    return out
  }
}

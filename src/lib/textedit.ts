import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFObject,
} from 'pdf-lib'
import { Encodings, Font as StdFont, FontNames } from '@pdf-lib/standard-fonts'

/**
 * True text editing: removes the original words of an edited line from the
 * page's content stream, so the old text is really gone from the file (not
 * just covered) and the replacement sits in its place.
 *
 * The content stream is tokenised and run through a small interpreter that
 * tracks the graphics and text state (q/Q/cm, BT/Tm/Td/TD/T*, Tf/Tc/Tw/Tz/TL)
 * and works out where every text-showing operation starts. Strings that start
 * on an edited line are replaced by an equal-width *move* (a TJ kerning
 * number), so nothing else on the page shifts. Everything not touched stays
 * byte-for-byte as it was.
 *
 * Anything it can't be sure of — text inside form XObjects, fonts with
 * unknown widths, odd encodings — is left alone, and the caller falls back to
 * covering the old line instead.
 */

/** An edited line, in the source page's own user space (PDF coordinates). */
export interface LineTarget {
  /** start of the line's baseline */
  ox: number
  oy: number
  /** unit vector along the baseline */
  dx: number
  dy: number
  /** length along the baseline */
  len: number
  /** font size, used for the matching tolerance */
  size: number
}

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function mul(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ]
}

// ---------------------------------------------------------------- tokenizer

type Tok =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'name'; v: string; s: number; e: number }
  | { t: 'str'; v: Uint8Array; s: number; e: number }
  | { t: 'arr'; v: Tok[]; s: number; e: number }
  | { t: 'dict'; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number }

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

class Lexer {
  i = 0
  constructor(private b: Uint8Array) {}

  private skipWs() {
    const b = this.b
    for (;;) {
      while (this.i < b.length && WS.has(b[this.i])) this.i++
      if (b[this.i] === 0x25) {
        while (this.i < b.length && b[this.i] !== 0x0a && b[this.i] !== 0x0d) this.i++
        continue
      }
      return
    }
  }

  next(): Tok | null {
    this.skipWs()
    const b = this.b
    if (this.i >= b.length) return null
    const s = this.i
    const c = b[this.i]
    if (c === 0x28) return { t: 'str', v: this.literal(), s, e: this.i }
    if (c === 0x3c && b[this.i + 1] === 0x3c) {
      this.skipDict()
      return { t: 'dict', s, e: this.i }
    }
    if (c === 0x3c) return { t: 'str', v: this.hex(), s, e: this.i }
    if (c === 0x5b) {
      this.i++
      const items: Tok[] = []
      for (;;) {
        this.skipWs()
        if (this.i >= b.length) throw new Error('unterminated array')
        if (b[this.i] === 0x5d) {
          this.i++
          break
        }
        const t = this.next()
        if (!t) throw new Error('unterminated array')
        items.push(t)
      }
      return { t: 'arr', v: items, s, e: this.i }
    }
    if (c === 0x2f) {
      this.i++
      const st = this.i
      while (this.i < b.length && !WS.has(b[this.i]) && !DELIM.has(b[this.i])) this.i++
      return { t: 'name', v: String.fromCharCode(...b.subarray(st, this.i)), s, e: this.i }
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      // Stray delimiter: step over it as its own (meaningless) operator.
      this.i++
      return { t: 'op', v: String.fromCharCode(c), s, e: this.i }
    }
    while (this.i < b.length && !WS.has(b[this.i]) && !DELIM.has(b[this.i])) this.i++
    const word = String.fromCharCode(...b.subarray(s, this.i))
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: Number(word), s, e: this.i }
    return { t: 'op', v: word, s, e: this.i }
  }

  private literal(): Uint8Array {
    const b = this.b
    const out: number[] = []
    let depth = 0
    this.i++ // (
    while (this.i < b.length) {
      const c = b[this.i++]
      if (c === 0x5c) {
        const n = b[this.i++]
        if (n === 0x6e) out.push(0x0a)
        else if (n === 0x72) out.push(0x0d)
        else if (n === 0x74) out.push(0x09)
        else if (n === 0x62) out.push(0x08)
        else if (n === 0x66) out.push(0x0c)
        else if (n === 0x0d) {
          if (b[this.i] === 0x0a) this.i++
        } else if (n === 0x0a) {
          /* line continuation */
        } else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30
          for (let k = 0; k < 2 && b[this.i] >= 0x30 && b[this.i] <= 0x37; k++) v = v * 8 + (b[this.i++] - 0x30)
          out.push(v & 0xff)
        } else out.push(n)
      } else if (c === 0x28) {
        depth++
        out.push(c)
      } else if (c === 0x29) {
        if (depth === 0) break
        depth--
        out.push(c)
      } else out.push(c)
    }
    return new Uint8Array(out)
  }

  private hex(): Uint8Array {
    const b = this.b
    this.i++ // <
    let digits = ''
    while (this.i < b.length && b[this.i] !== 0x3e) {
      const ch = String.fromCharCode(b[this.i++])
      if (/[0-9a-fA-F]/.test(ch)) digits += ch
    }
    this.i++ // >
    if (digits.length % 2) digits += '0'
    const out = new Uint8Array(digits.length / 2)
    for (let k = 0; k < out.length; k++) out[k] = parseInt(digits.substr(k * 2, 2), 16)
    return out
  }

  private skipDict() {
    const b = this.b
    let depth = 0
    while (this.i < b.length) {
      if (b[this.i] === 0x3c && b[this.i + 1] === 0x3c) {
        depth++
        this.i += 2
      } else if (b[this.i] === 0x3e && b[this.i + 1] === 0x3e) {
        depth--
        this.i += 2
        if (depth === 0) return
      } else if (b[this.i] === 0x28) {
        this.literal()
      } else this.i++
    }
  }

  /** After a BI … ID inline image header: skip the binary data up to EI. */
  skipInlineImage() {
    const b = this.b
    // One whitespace byte follows ID, then raw data until "EI" surrounded by whitespace.
    this.i++
    while (this.i < b.length - 2) {
      if (
        WS.has(b[this.i]) &&
        b[this.i + 1] === 0x45 &&
        b[this.i + 2] === 0x49 &&
        (this.i + 3 >= b.length || WS.has(b[this.i + 3]) || DELIM.has(b[this.i + 3]))
      ) {
        this.i += 3
        return
      }
      this.i++
    }
    this.i = b.length
  }
}

// --------------------------------------------------------------- font widths

interface FontInfo {
  /** bytes per character code */
  bytes: 1 | 2
  /** width in text-space units (already divided by 1000 / scaled by FontMatrix) */
  width: (code: number) => number
}

const STANDARD: Record<string, FontNames> = {
  Helvetica: FontNames.Helvetica,
  'Helvetica-Bold': FontNames.HelveticaBold,
  'Helvetica-Oblique': FontNames.HelveticaOblique,
  'Helvetica-BoldOblique': FontNames.HelveticaBoldOblique,
  'Times-Roman': FontNames.TimesRoman,
  'Times-Bold': FontNames.TimesRomanBold,
  'Times-Italic': FontNames.TimesRomanItalic,
  'Times-BoldItalic': FontNames.TimesRomanBoldItalic,
  Courier: FontNames.Courier,
  'Courier-Bold': FontNames.CourierBold,
  'Courier-Oblique': FontNames.CourierOblique,
  'Courier-BoldOblique': FontNames.CourierBoldOblique,
  Symbol: FontNames.Symbol,
  ZapfDingbats: FontNames.ZapfDingbats,
  Arial: FontNames.Helvetica,
  'Arial,Bold': FontNames.HelveticaBold,
  TimesNewRoman: FontNames.TimesRoman,
  'TimesNewRoman,Bold': FontNames.TimesRomanBold,
  CourierNew: FontNames.Courier,
}

let winAnsiNames: Map<number, string> | null = null
function winAnsiCodeToName(): Map<number, string> {
  if (!winAnsiNames) {
    winAnsiNames = new Map()
    const enc = Encodings.WinAnsi
    for (const cp of enc.supportedCodePoints) {
      const { code, name } = enc.encodeUnicodeCodePoint(cp)
      winAnsiNames.set(code, name)
    }
  }
  return winAnsiNames
}

function num(v: PDFObject | undefined): number | null {
  return v instanceof PDFNumber ? v.asNumber() : null
}

function readFont(doc: PDFDocument, fontObj: PDFObject | undefined): FontInfo | null {
  const font = fontObj instanceof PDFRef ? doc.context.lookup(fontObj) : fontObj
  if (!(font instanceof PDFDict)) return null
  const subtype = font.lookup(PDFName.of('Subtype'))
  const sub = subtype instanceof PDFName ? subtype.decodeText() : ''

  if (sub === 'Type0') {
    const enc = font.lookup(PDFName.of('Encoding'))
    const encName = enc instanceof PDFName ? enc.decodeText() : ''
    // Only the identity CMaps are 2-byte = CID; anything else needs the CMap.
    if (encName !== 'Identity-H') return null
    const kids = font.lookup(PDFName.of('DescendantFonts'))
    const cid = kids instanceof PDFArray ? kids.lookup(0) : null
    if (!(cid instanceof PDFDict)) return null
    const dw = num(cid.lookup(PDFName.of('DW'))) ?? 1000
    const widths = new Map<number, number>()
    const w = cid.lookup(PDFName.of('W'))
    if (w instanceof PDFArray) {
      for (let i = 0; i < w.size(); ) {
        const first = num(w.lookup(i))
        const next = w.lookup(i + 1)
        if (first === null) break
        if (next instanceof PDFArray) {
          for (let k = 0; k < next.size(); k++) widths.set(first + k, num(next.lookup(k)) ?? dw)
          i += 2
        } else {
          const last = num(next)
          const value = num(w.lookup(i + 2))
          if (last === null || value === null) break
          for (let c = first; c <= last && c - first < 70000; c++) widths.set(c, value)
          i += 3
        }
      }
    }
    return { bytes: 2, width: (c) => (widths.get(c) ?? dw) / 1000 }
  }

  if (sub === 'Type1' || sub === 'TrueType' || sub === 'MMType1' || sub === 'Type3') {
    const scale =
      sub === 'Type3'
        ? (() => {
            const fm = font.lookup(PDFName.of('FontMatrix'))
            return fm instanceof PDFArray ? (num(fm.lookup(0)) ?? 0.001) : 0.001
          })()
        : 0.001
    const first = num(font.lookup(PDFName.of('FirstChar')))
    const widthsArr = font.lookup(PDFName.of('Widths'))
    const desc = font.lookup(PDFName.of('FontDescriptor'))
    const missing = desc instanceof PDFDict ? (num(desc.lookup(PDFName.of('MissingWidth'))) ?? 0) : 0
    if (first !== null && widthsArr instanceof PDFArray) {
      const ws: number[] = []
      for (let i = 0; i < widthsArr.size(); i++) ws.push(num(widthsArr.lookup(i)) ?? missing)
      return { bytes: 1, width: (c) => (ws[c - first] ?? missing) * scale }
    }
    if (sub === 'Type3') return null
    // A standard-14 font with no /Widths: use the built-in metrics.
    const base = font.lookup(PDFName.of('BaseFont'))
    const baseName = base instanceof PDFName ? base.decodeText().replace(/^[A-Z]{6}\+/, '') : ''
    const std = STANDARD[baseName]
    if (!std) return null
    const metrics = StdFont.load(std)
    const byCode = new Map<number, string>()
    const enc = font.lookup(PDFName.of('Encoding'))
    let encName = enc instanceof PDFName ? enc.decodeText() : ''
    let diffs: PDFArray | null = null
    if (enc instanceof PDFDict) {
      const be = enc.lookup(PDFName.of('BaseEncoding'))
      encName = be instanceof PDFName ? be.decodeText() : ''
      const d = enc.lookup(PDFName.of('Differences'))
      diffs = d instanceof PDFArray ? d : null
    }
    if (encName === 'WinAnsiEncoding') for (const [c, n] of winAnsiCodeToName()) byCode.set(c, n)
    else {
      // StandardEncoding: ASCII-compatible for printable characters apart
      // from the two quote marks. (Codes above 126 are rare without an
      // explicit encoding, and simply count as zero width.)
      for (const [c, n] of winAnsiCodeToName()) if (c >= 32 && c <= 126) byCode.set(c, n)
      byCode.set(39, 'quoteright')
      byCode.set(96, 'quoteleft')
    }
    if (diffs) {
      let code = 0
      for (let i = 0; i < diffs.size(); i++) {
        const v = diffs.lookup(i)
        if (v instanceof PDFNumber) code = v.asNumber()
        else if (v instanceof PDFName) byCode.set(code++, v.decodeText())
      }
    }
    return {
      bytes: 1,
      width: (c) => {
        const n = byCode.get(c)
        return ((n ? metrics.getWidthOfGlyph(n) : undefined) ?? 0) / 1000
      },
    }
  }
  return null
}

// --------------------------------------------------------------- interpreter

interface Replacement {
  s: number
  e: number
  text: string
}

function onTarget(x: number, y: number, t: LineTarget): boolean {
  const px = x - t.ox
  const py = y - t.oy
  const along = px * t.dx + py * t.dy
  const across = Math.abs(px * t.dy - py * t.dx)
  return across <= Math.max(1, t.size * 0.3) && along >= -Math.max(1.5, t.size * 0.3) && along <= t.len + 1
}

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

/** Concatenated, decoded page content. */
function readContents(doc: PDFDocument, pageIndex: number): Uint8Array | null {
  const page = doc.getPage(pageIndex)
  const contents = page.node.get(PDFName.of('Contents'))
  const refs: PDFObject[] = []
  const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents
  if (resolved instanceof PDFArray) for (let i = 0; i < resolved.size(); i++) refs.push(resolved.get(i))
  else if (contents) refs.push(contents)
  const parts: Uint8Array[] = []
  for (const r of refs) {
    const s = r instanceof PDFRef ? doc.context.lookup(r) : r
    if (s instanceof PDFRawStream) parts.push(decodePDFRawStream(s).decode())
    else if (s instanceof PDFStream) parts.push(s.getContents())
    else return null
  }
  const total = parts.reduce((n, p) => n + p.length + 1, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
    out[o++] = 0x0a
  }
  return out
}

/**
 * Removes the text of every target line from page `pageIndex` of `doc`
 * (modifying `doc`). Returns, per target, whether any of its text was found
 * and removed.
 */
export function removeTextLines(doc: PDFDocument, pageIndex: number, targets: LineTarget[]): boolean[] {
  const hit = targets.map(() => false)
  if (!targets.length) return hit
  let bytes: Uint8Array | null
  try {
    bytes = readContents(doc, pageIndex)
  } catch {
    return hit
  }
  if (!bytes) return hit

  const page = doc.getPage(pageIndex)
  const resources = page.node.Resources()
  const fontsDict = resources?.lookup(PDFName.of('Font'))
  const fontCache = new Map<string, FontInfo | null>()
  const fontFor = (name: string) => {
    if (!fontCache.has(name)) {
      const f = fontsDict instanceof PDFDict ? fontsDict.get(PDFName.of(name)) : undefined
      let info: FontInfo | null = null
      try {
        info = readFont(doc, f)
      } catch {
        info = null
      }
      fontCache.set(name, info)
    }
    return fontCache.get(name)!
  }

  const lexer = new Lexer(bytes)
  // q/Q save and restore the whole graphics state, text parameters included.
  const stack: Array<{ ctm: Matrix; font: FontInfo | null; size: number; tc: number; tw: number; th: number; tl: number; rise: number }> = []
  let ctm: Matrix = [...IDENTITY]
  let tm: Matrix = [...IDENTITY]
  let tlm: Matrix = [...IDENTITY]
  let font: FontInfo | null = null
  let size = 0
  let tc = 0
  let tw = 0
  let th = 1
  let tl = 0
  let rise = 0
  const operands: Tok[] = []
  const replacements: Replacement[] = []

  const nextLine = () => {
    tlm = mul([1, 0, 0, 1, 0, -tl], tlm)
    tm = [...tlm]
  }

  /** Advance (in text space, before Th) of one string, and moves tm past it. */
  const advanceOf = (str: Uint8Array): number => {
    if (!font) return NaN
    let adv = 0
    for (let k = 0; k + font.bytes <= str.length; k += font.bytes) {
      const code = font.bytes === 2 ? (str[k] << 8) | str[k + 1] : str[k]
      adv += font.width(code) * size + tc + (font.bytes === 1 && code === 32 ? tw : 0)
    }
    return adv
  }

  /** Handles one string being shown; returns true if it was on a target. */
  const show = (str: Uint8Array): { matched: boolean; adv: number } => {
    const user = mul(tm, ctm)
    const ox = user[4] + user[2] * rise
    const oy = user[5] + user[3] * rise
    let matched = false
    targets.forEach((t, i) => {
      if (onTarget(ox, oy, t)) {
        matched = true
        hit[i] = true
      }
    })
    const adv = advanceOf(str)
    tm = mul([1, 0, 0, 1, adv * th, 0], tm)
    return { matched, adv }
  }

  /** TJ kerning number that moves the pen by `adv` (text space, pre-Th). */
  const moveBy = (adv: number) => (size ? fmt((-adv / size) * 1000) : '0')

  let tok: Tok | null
  let failed = false
  try {
    while ((tok = lexer.next())) {
      if (tok.t !== 'op') {
        operands.push(tok)
        continue
      }
      const op = tok.v
      const n = (k: number) => {
        const o = operands[operands.length - k]
        return o && o.t === 'num' ? o.v : 0
      }
      const start = operands[0]?.s ?? tok.s
      switch (op) {
        case 'q':
          stack.push({ ctm: [...ctm], font, size, tc, tw, th, tl, rise })
          break
        case 'Q': {
          const st = stack.pop()
          if (st) ({ ctm, font, size, tc, tw, th, tl, rise } = st)
          break
        }
        case 'cm':
          ctm = mul([n(6), n(5), n(4), n(3), n(2), n(1)], ctm)
          break
        case 'BT':
          tm = [...IDENTITY]
          tlm = [...IDENTITY]
          break
        case 'Tf': {
          const name = operands[operands.length - 2]
          font = name && name.t === 'name' ? fontFor(name.v) : null
          size = n(1)
          break
        }
        case 'Tc':
          tc = n(1)
          break
        case 'Tw':
          tw = n(1)
          break
        case 'Tz':
          th = n(1) / 100
          break
        case 'TL':
          tl = n(1)
          break
        case 'Ts':
          rise = n(1)
          break
        case 'Td':
          tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm)
          tm = [...tlm]
          break
        case 'TD':
          tl = -n(1)
          tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm)
          tm = [...tlm]
          break
        case 'Tm':
          tlm = [n(6), n(5), n(4), n(3), n(2), n(1)]
          tm = [...tlm]
          break
        case 'T*':
          nextLine()
          break
        case 'Tj':
        case "'":
        case '"': {
          const strTok = operands[operands.length - 1]
          if (!strTok || strTok.t !== 'str') break
          let prefix = ''
          if (op === '"') {
            tw = n(3)
            tc = n(2)
            prefix = `${fmt(tw)} Tw ${fmt(tc)} Tc `
          }
          if (op !== 'Tj') nextLine()
          if (op !== 'Tj') prefix += 'T* '
          const { matched, adv } = show(strTok.v)
          if (matched) {
            if (!font || Number.isNaN(adv)) {
              failed = true
              break
            }
            replacements.push({ s: start, e: tok.e, text: `${prefix}[${moveBy(adv)}] TJ` })
          }
          break
        }
        case 'TJ': {
          const arrTok = operands[operands.length - 1]
          if (!arrTok || arrTok.t !== 'arr') break
          const parts: string[] = []
          let changed = false
          for (const el of arrTok.v) {
            if (el.t === 'num') {
              tm = mul([1, 0, 0, 1, (-el.v / 1000) * size * th, 0], tm)
              parts.push(String.fromCharCode(...bytes.subarray(el.s, el.e)))
            } else if (el.t === 'str') {
              const { matched, adv } = show(el.v)
              if (matched) {
                if (!font || Number.isNaN(adv)) {
                  failed = true
                  break
                }
                changed = true
                parts.push(moveBy(adv))
              } else {
                parts.push(String.fromCharCode(...bytes.subarray(el.s, el.e)))
              }
            }
          }
          if (changed && !failed) replacements.push({ s: start, e: tok.e, text: `[${parts.join(' ')}] TJ` })
          break
        }
        case 'BI':
          // Inline image: skip its dictionary and binary data.
          while ((tok = lexer.next()) && !(tok.t === 'op' && tok.v === 'ID')) {
            /* header */
          }
          lexer.skipInlineImage()
          break
      }
      operands.length = 0
      if (failed) break
    }
  } catch {
    failed = true
  }

  if (failed || !replacements.length) return targets.map(() => false)

  // Splice the replacements into the original bytes.
  replacements.sort((a, b) => a.s - b.s)
  const chunks: Uint8Array[] = []
  let at = 0
  const enc = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff)
  for (const r of replacements) {
    if (r.s < at) continue
    chunks.push(bytes.subarray(at, r.s), enc(r.text))
    at = r.e
  }
  chunks.push(bytes.subarray(at))
  const total = chunks.reduce((k, c) => k + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  const stream = doc.context.flateStream(out)
  page.node.set(PDFName.of('Contents'), doc.context.register(stream))
  return hit
}

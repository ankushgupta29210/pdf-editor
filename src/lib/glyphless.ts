import { PDFDocument, PDFRef, PDFString } from 'pdf-lib'

/**
 * A "glyphless" Type0 font for the invisible text layer, the same idea
 * Tesseract and OCRmyPDF use. Codes are 2-byte Unicode (BMP) values and the
 * ToUnicode map is the identity, so copy, search and screen readers get the
 * exact recognised characters in any script — Hindi, Arabic, Chinese… — with
 * no font file to embed (the text is never painted: render mode 3).
 */
export function addGlyphlessFont(doc: PDFDocument): PDFRef {
  const ctx = doc.context
  const ranges: string[] = []
  for (let hi = 0; hi < 256; hi++) {
    if (hi >= 0xd8 && hi <= 0xdf) continue // surrogate halves are not characters
    const h = hi.toString(16).padStart(2, '0').toUpperCase()
    ranges.push(`<${h}00> <${h}FF> <${h}00>`)
  }
  const chunks: string[] = []
  for (let i = 0; i < ranges.length; i += 100) {
    const part = ranges.slice(i, i + 100)
    chunks.push(`${part.length} beginbfrange\n${part.join('\n')}\nendbfrange`)
  }
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...chunks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
  const toUnicode = ctx.register(ctx.flateStream(cmap))
  const descriptor = ctx.register(
    ctx.obj({
      Type: 'FontDescriptor',
      FontName: 'GlyphLessFont',
      Flags: 5,
      FontBBox: [0, 0, 500, 1000],
      ItalicAngle: 0,
      Ascent: 1000,
      Descent: 0,
      CapHeight: 1000,
      StemV: 80,
    }),
  )
  const cidFont = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'GlyphLessFont',
      CIDSystemInfo: {
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('Identity'),
        Supplement: 0,
      },
      FontDescriptor: descriptor,
      DW: 500,
      CIDToGIDMap: 'Identity',
    }),
  )
  return ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'GlyphLessFont',
      Encoding: 'Identity-H',
      DescendantFonts: [cidFont],
      ToUnicode: toUnicode,
    }),
  )
}

/** UTF-16BE hex for the BMP characters of `text` (others are dropped). */
export function utf16Hex(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp > 0xffff) continue
    out += cp.toString(16).padStart(4, '0')
  }
  return out
}


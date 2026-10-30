/**
 * Word / Excel / PowerPoint → PDF: entry point and shared helpers.
 *
 * Each format is first laid out as ordinary HTML in a hidden part of the page
 * (docx-preview for Word; our own renderers for Excel and PowerPoint), using
 * metric-compatible fonts, then dom-to-pdf turns that layout into a real PDF
 * with selectable text. Everything happens in the browser; the file is never
 * uploaded anywhere.
 */
import { cssStack, mapFamily, mapSymbolText, registerOfficeFonts } from './office-fonts'

export const OFFICE_EXT = /\.(docx|docm|dotx|xlsx|xlsm|xltx|pptx|pptm|ppsx|potx)$/i
const LEGACY_EXT = /\.(doc|dot|xls|xlt|ppt|pps|pot|odt|ods|odp|rtf|pages|numbers|key)$/i
export const OFFICE_ACCEPT =
  '.docx,.docm,.dotx,.xlsx,.xlsm,.xltx,.pptx,.pptm,.ppsx,.potx,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

export function isOfficeFile(f: File): boolean {
  return OFFICE_EXT.test(f.name) || /officedocument\.(wordprocessingml|spreadsheetml|presentationml)/.test(f.type)
}
export function isLegacyOfficeFile(f: File): boolean {
  return LEGACY_EXT.test(f.name)
}
export function legacyMessage(name: string): string {
  const ext = (/\.([a-z]+)$/i.exec(name)?.[1] ?? '').toLowerCase()
  const modern = /^(doc|dot|odt|rtf|pages)$/.test(ext) ? '.docx' : /^(xls|xlt|ods|numbers)$/.test(ext) ? '.xlsx' : '.pptx'
  return `${name}: .${ext} files can't be converted here — open it in its app and save it as ${modern} first.`
}

export interface OfficeResult {
  bytes: Uint8Array
  /** Things the conversion had to leave out, to tell the user about. */
  warnings: string[]
}

export async function officeToPdf(file: File, onProgress?: (f: number) => void): Promise<OfficeResult> {
  const data = await file.arrayBuffer()
  const name = file.name.toLowerCase()
  const kind = /\.(xlsx|xlsm|xltx)$/.test(name) || file.type.includes('spreadsheetml')
    ? 'xlsx'
    : /\.(pptx|pptm|ppsx|potx)$/.test(name) || file.type.includes('presentationml')
      ? 'pptx'
      : 'docx'
  const title = file.name.replace(/\.[a-z0-9]+$/i, '')
  try {
    if (kind === 'docx') return await (await import('./docx-to-pdf')).docxToPdf(data, { title, onProgress })
    if (kind === 'xlsx') return await (await import('./xlsx-to-pdf')).xlsxToPdf(data, { title, onProgress })
    return await (await import('./pptx-to-pdf')).pptxToPdf(data, { title, onProgress })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/zip|central directory|signature|end of data|invalid/i.test(msg))
      throw new Error('this file is damaged or password-protected, so it could not be converted')
    throw err
  }
}

const BASE_CSS = `
.pe-office { position: fixed; left: -40000px; top: 0; z-index: -1; pointer-events: none; background: #fff; color: #000; }
.pe-office, .pe-office * {
  font-kerning: none !important;
  font-variant-ligatures: none !important;
  font-feature-settings: "liga" 0, "clig" 0, "kern" 0 !important;
  text-rendering: optimizeSpeed !important;
  -webkit-font-smoothing: auto;
  hyphens: manual !important;
}
.pe-office .pe-nobefore::before { content: none !important; }
`

/** A hidden, laid-out container for building pages in. Remove when done. */
export function makeHost(): HTMLElement {
  registerOfficeFonts()
  if (!document.getElementById('pe-office-style')) {
    const style = document.createElement('style')
    style.id = 'pe-office-style'
    style.textContent = BASE_CSS
    document.head.appendChild(style)
  }
  const host = document.createElement('div')
  host.className = 'pe-office'
  host.setAttribute('aria-hidden', 'true')
  document.body.appendChild(host)
  return host
}

/** Every font used under `root` is switched to its bundled stand-in, and
 *  symbol-font characters are turned into real Unicode. */
export function remapFonts(root: HTMLElement) {
  const els = [root, ...root.querySelectorAll<HTMLElement | SVGElement>('*')]
  const fams = new Map<Element, string>()
  for (const el of els) fams.set(el, getComputedStyle(el).fontFamily)
  // Symbol / Wingdings text first, while the original names are known.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const fam = fams.get(n.parentElement!) ?? ''
    if (/[\uF000-\uF0FF]/.test(n.data) || /symbol|wingdings|webdings/i.test(fam)) n.data = mapSymbolText(n.data, fam)
  }
  for (const el of els) {
    const fam = fams.get(el)!
    const parentFam = el === root ? null : fams.get(el.parentElement!)
    if (parentFam === fam) continue
    el.style.setProperty('font-family', cssStack(mapFamily(fam)), 'important')
  }
}

function roman(n: number): string {
  const t: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ]
  let out = ''
  for (const [v, s] of t) while (n >= v) {
    out += s
    n -= v
  }
  return out
}
function alpha(n: number): string {
  let s = ''
  while (n > 0) {
    n--
    s = String.fromCharCode(97 + (n % 26)) + s
    n = Math.floor(n / 26)
  }
  return s
}
export function counterText(n: number, style: string): string {
  switch (style.trim()) {
    case 'lower-alpha':
    case 'lower-latin':
      return alpha(n)
    case 'upper-alpha':
    case 'upper-latin':
      return alpha(n).toUpperCase()
    case 'lower-roman':
      return roman(n)
    case 'upper-roman':
      return roman(n).toUpperCase()
    case 'decimal-leading-zero':
      return String(n).padStart(2, '0')
    case 'disc':
      return '•'
    case 'circle':
      return '○'
    case 'square':
      return '▪'
    case 'none':
      return ''
    default:
      return String(n)
  }
}

function parseCounterList(v: string, dflt: number): Array<[string, number]> {
  if (!v || v === 'none') return []
  const out: Array<[string, number]> = []
  const parts = v.trim().split(/\s+/)
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]
    const next = parts[i + 1]
    if (next !== undefined && /^-?\d+$/.test(next)) {
      out.push([name, parseInt(next)])
      i++
    } else out.push([name, dflt])
  }
  return out
}

/** Unquotes a CSS string token, resolving escapes like \9 (tab). */
function cssString(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex: string, ch: string) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : ch,
  )
}

/**
 * Generated content (::before — list bullets and numbers in docx-preview's
 * output) is invisible to text measurement, so it is turned into real
 * elements, with CSS counters worked out here.
 */
export function materializeBefore(root: HTMLElement) {
  const counters = new Map<string, number>()
  const els = [...root.querySelectorAll<HTMLElement>('*')]
  for (const el of els) {
    const cs = getComputedStyle(el)
    for (const [n, v] of parseCounterList(cs.counterReset, 0)) counters.set(n, v)
    for (const [n, v] of parseCounterList(cs.counterSet, 0)) counters.set(n, v)
    for (const [n, v] of parseCounterList(cs.counterIncrement, 1)) counters.set(n, (counters.get(n) ?? 0) + v)
    const ps = getComputedStyle(el, '::before')
    const content = ps.content
    if (!content || content === 'none' || content === 'normal') continue
    for (const [n, v] of parseCounterList(ps.counterReset, 0)) counters.set(n, v)
    for (const [n, v] of parseCounterList(ps.counterIncrement, 1)) counters.set(n, (counters.get(n) ?? 0) + v)
    let text = ''
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|counters?\(([^)]*)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content))) {
      if (m[1] !== undefined || m[2] !== undefined) text += cssString(m[1] ?? m[2])
      else {
        const args = m[3].split(',').map((a) => a.trim())
        const style = m[0].startsWith('counters') ? (args[2] ?? 'decimal') : (args[1] ?? 'decimal')
        text += counterText(counters.get(args[0]) ?? 0, style)
      }
    }
    // A marker with no font of its own takes the paragraph text's font, as
    // in Word (docx-preview leaves it on the page's default font).
    let look: CSSStyleDeclaration = ps
    if (ps.fontFamily === cs.fontFamily) {
      const first = [...el.querySelectorAll('span')].find((x) => x.textContent?.trim())
      if (first) look = getComputedStyle(first)
    }
    const span = document.createElement('span')
    const hang = -(parseFloat(cs.textIndent) || 0)
    const trimmed = mapSymbolText(text.replace(/[\t ]+$/, ''), ps.fontFamily)
    text = mapSymbolText(text, ps.fontFamily) + (text.length > text.trimEnd().length ? ' ' : '')
    span.textContent = trimmed
    span.style.cssText = [
      `font-family:${look.fontFamily}`,
      `font-size:${look.fontSize}`,
      `font-weight:${ps.fontWeight}`,
      `font-style:${ps.fontStyle}`,
      `color:${look.color}`,
      'text-indent:0',
      'white-space:pre',
      'text-decoration:none',
      // The text after a list marker starts at the hanging indent, like a
      // tab stop in Word.
      hang > 0 && trimmed !== text ? `display:inline-block;min-width:${hang}px` : 'display:inline',
    ].join(';')
    if (trimmed !== text && !(hang > 0)) span.textContent = trimmed + ' '
    el.insertBefore(span, el.firstChild)
    el.classList.add('pe-nobefore')
  }
}

/** Waits until every font used under `root` has loaded (so measurements are
 *  final) and every picture has decoded. */
export async function settle(root: HTMLElement) {
  void root.offsetHeight
  const wanted = new Map<string, string>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.data.trim() || !n.parentElement) continue
    const cs = getComputedStyle(n.parentElement)
    const key = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const prev = wanted.get(key) ?? ''
    if (prev.length < 4000) wanted.set(key, prev + n.data)
  }
  await Promise.all(
    [...wanted].map(([font, text]) => document.fonts.load(font, text).catch(() => [])),
  )
  await Promise.all(
    [...root.querySelectorAll('img')].map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))),
  )
  await document.fonts.ready
  void root.offsetHeight
}

/**
 * Excel (.xlsx) → PDF. The workbook is read directly (it is a zip of XML
 * parts) and each visible sheet is laid out as an HTML table with Excel's own
 * column widths, row heights, fonts, fills, borders, merged cells, alignment
 * and number formats; dom-to-pdf then splits it into pages between rows.
 *
 * Like Excel, a sheet prints its print area if one is set (else everything
 * with a value), without gridlines unless "print gridlines" is on. Sheets too
 * wide for the page are turned landscape and scaled to fit the width rather
 * than chopped into column strips.
 */
import { unzipSync } from 'fflate'
import { domToPdf, type FlowSection } from './dom-to-pdf'
import { cssStack, mapFamily } from './office-fonts'
import { makeHost, settle, type OfficeResult } from './office-common'
import { all, kid, kids, rels, xml, type Files } from './ooxml'

const EMU_PER_PX = 9525

// ---------- colours ----------

const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
]

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
}
const hex = (rgb: [number, number, number]) =>
  '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')

function applyTint(hexColor: string, tint: number): string {
  if (!tint) return '#' + hexColor
  const r = parseInt(hexColor.slice(0, 2), 16) / 255
  const g = parseInt(hexColor.slice(2, 4), 16) / 255
  const b = parseInt(hexColor.slice(4, 6), 16) / 255
  const [h, s, l] = rgbToHsl(r, g, b)
  const nl = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint
  return hex(hslToRgb(h, s, nl))
}

class Theme {
  colors: string[] = ['FFFFFF', '000000', 'EEECE1', '1F497D', '4F81BD', 'C0504D', '9BBB59', '8064A2', '4BACC6', 'F79646', '0000FF', '800080']
  constructor(doc: Document | null) {
    const scheme = all(doc, 'clrScheme')[0]
    if (!scheme) return
    const val = (name: string) => {
      const el = kid(scheme, name)
      const c = el?.firstElementChild
      if (!c) return null
      return c.getAttribute('lastClr') ?? c.getAttribute('val')
    }
    const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
    order.forEach((n, i) => {
      const v = val(n)
      if (v && /^[0-9a-f]{6}$/i.test(v)) this.colors[i] = v.toUpperCase()
    })
  }
  color(el: Element | null | undefined): string | null {
    if (!el) return null
    if (el.getAttribute('auto') === '1') return null
    const tint = parseFloat(el.getAttribute('tint') ?? '0') || 0
    const rgbAttr = el.getAttribute('rgb')
    if (rgbAttr) {
      const v = rgbAttr.length === 8 ? rgbAttr.slice(2) : rgbAttr
      return applyTint(v, tint)
    }
    const theme = el.getAttribute('theme')
    if (theme !== null) return applyTint(this.colors[+theme] ?? '000000', tint)
    const idx = el.getAttribute('indexed')
    if (idx !== null) {
      const i = +idx
      if (i === 64) return null
      if (i === 65) return '#ffffff'
      return applyTint(INDEXED[i] ?? '000000', tint)
    }
    return null
  }
}

// ---------- number formats ----------

const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)',
  8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const COLORS: Record<string, string> = {
  red: '#ff0000',
  blue: '#0000ff',
  green: '#00ff00',
  yellow: '#ffff00',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  white: '#ffffff',
  black: '#000000',
}

/** Splits a format code into its ;-separated sections (outside quotes). */
function sections(code: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (ch === '"') q = !q
    if (ch === '\\' && !q) {
      cur += ch + (code[i + 1] ?? '')
      i++
      continue
    }
    if (ch === ';' && !q) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

function generalNumber(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e11) return String(v)
  const abs = Math.abs(v)
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-9)) return v.toExponential(5).replace(/\.?0+e/, 'E').replace('E+', 'E+').replace(/e/, 'E')
  let s = v.toPrecision(10)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

function isDateCode(sec: string): boolean {
  const s = sec.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '')
  return /[ymdhs]/i.test(s) && !/[0#?]/.test(s.replace(/\.0+/g, ''))
}

function formatDate(serial: number, sec: string, date1904: boolean): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86400000)
  // Excel's day 0 is 1899-12-30 once the fictional 1900-02-29 is skipped.
  const base = Date.UTC(1899, 11, 30)
  const d = new Date(base + (serial < 60 && !date1904 ? ms + 86400000 : ms))
  const Y = d.getUTCFullYear()
  const M = d.getUTCMonth()
  const D = d.getUTCDate()
  const W = d.getUTCDay()
  const h = d.getUTCHours()
  const mi = d.getUTCMinutes()
  const sFrac = (ms / 1000) % 60
  const s = d.getUTCSeconds()
  const ampm = /AM\/PM|A\/P/i.test(sec)
  const totalHours = Math.floor(serial * 24)
  let out = ''
  const tokens = sec.match(/"[^"]*"|\\.|\[[hms]+\]|\[[^\]]*\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|am\/pm|A\/P|a\/p|\.0+|./gi) ?? []
  const lower = tokens.map((t) => t.toLowerCase())
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const l = lower[i]
    // "m" means minutes right after an hour or right before seconds.
    const prev = lower.slice(0, i).reverse().find((x) => /^[a-z[]/.test(x))
    const next = lower.slice(i + 1).find((x) => /^[a-z[]/.test(x))
    const minute = (l === 'm' || l === 'mm') && ((prev && /^(h|hh|\[h\])$/.test(prev)) || (next && /^(s|ss)$/.test(next)))
    if (t.startsWith('"')) out += t.slice(1, -1)
    else if (t.startsWith('\\')) out += t.slice(1)
    else if (l === '[h]') out += String(totalHours)
    else if (l === '[m]') out += String(Math.floor(serial * 1440))
    else if (l === '[s]') out += String(Math.floor(serial * 86400))
    else if (t.startsWith('[')) continue
    else if (l === 'yyyy') out += String(Y)
    else if (l === 'yy') out += String(Y % 100).padStart(2, '0')
    else if (minute) out += l === 'mm' ? String(mi).padStart(2, '0') : String(mi)
    else if (l === 'mmmmm') out += MONTHS[M][0]
    else if (l === 'mmmm') out += MONTHS[M]
    else if (l === 'mmm') out += MONTHS[M].slice(0, 3)
    else if (l === 'mm') out += String(M + 1).padStart(2, '0')
    else if (l === 'm') out += String(M + 1)
    else if (l === 'dddd') out += DAYS[W]
    else if (l === 'ddd') out += DAYS[W].slice(0, 3)
    else if (l === 'dd') out += String(D).padStart(2, '0')
    else if (l === 'd') out += String(D)
    else if (l === 'hh' || l === 'h') {
      let hv = h
      if (ampm) {
        hv = h % 12
        if (hv === 0) hv = 12
      }
      out += l === 'hh' ? String(hv).padStart(2, '0') : String(hv)
    } else if (l === 'ss') out += String(s).padStart(2, '0')
    else if (l === 's') out += String(s)
    else if (l === 'am/pm') out += h < 12 ? 'AM' : 'PM'
    else if (l === 'a/p') out += h < 12 ? 'A' : 'P'
    else if (l.startsWith('.0')) out += (sFrac % 1).toFixed(l.length - 1).slice(1)
    else out += t
  }
  return out
}

function formatNumberSection(v: number, sec: string): string {
  // Literal text, escapes and padding codes.
  let pct = 0
  let body = ''
  for (let i = 0; i < sec.length; i++) {
    const ch = sec[i]
    if (ch === '"') {
      const j = sec.indexOf('"', i + 1)
      body += '\u0001' + sec.slice(i + 1, j < 0 ? undefined : j) + '\u0002'
      i = j < 0 ? sec.length : j
    } else if (ch === '\\') {
      body += '\u0001' + (sec[i + 1] ?? '') + '\u0002'
      i++
    } else if (ch === '_') {
      body += '\u0001 \u0002'
      i++
    } else if (ch === '*') i++
    else if (ch === '[') {
      const j = sec.indexOf(']', i)
      const inner = sec.slice(i + 1, j)
      const cur = /^\$([^-\]]*)/.exec(inner)
      if (cur) body += '\u0001' + cur[1] + '\u0002'
      i = j < 0 ? sec.length : j
    } else {
      if (ch === '%') pct++
      body += ch
    }
  }
  if (pct) v *= 100 ** pct
  const sci = /[eE][+-]/.exec(body)
  const first = body.search(/[0#?]/)
  if (first < 0) return body.replace(/[\u0001\u0002]/g, '')
  let last = first
  for (let i = first; i < body.length; i++) {
    if (body[i] === '\u0001') {
      const j = body.indexOf('\u0002', i)
      // literal inside the number pattern ends it unless more digits follow
      if (!/[0#?]/.test(body.slice(j + 1))) break
      i = j
      continue
    }
    if (/[0#?,.]/.test(body[i]) || (sci && /[eE+\-]/.test(body[i]))) last = i
  }
  const prefix = body.slice(0, first).replace(/[\u0001\u0002]/g, '')
  const pattern = body.slice(first, last + 1).replace(/\u0001[^\u0002]*\u0002/g, '')
  const suffix = body.slice(last + 1).replace(/[\u0001\u0002]/g, '')

  if (sci) {
    const [mant, exp] = pattern.split(/[eE][+-]/)
    const dec = (mant.split('.')[1] ?? '').length
    let e = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(v)))
    const intDigits = (mant.split('.')[0] ?? '').replace(/[^0#?]/g, '').length
    if (intDigits > 1) e = Math.floor(e / intDigits) * intDigits
    let m = v / 10 ** e
    let ms = Math.abs(m).toFixed(dec)
    if (parseFloat(ms) >= 10 ** Math.max(1, intDigits)) {
      e += 1
      m = v / 10 ** e
      ms = Math.abs(m).toFixed(dec)
    }
    const es = String(Math.abs(e)).padStart((exp ?? '00').length, '0')
    return prefix + ms + 'E' + (e < 0 ? '-' : '+') + es + suffix
  }

  const [intPat, decPat = ''] = pattern.split('.')
  const thousands = /[0#?],[0#?]/.test(intPat)
  // trailing commas scale by 1000 each
  const scaleCommas = /,+$/.exec(intPat)?.[0].length ?? 0
  if (scaleCommas) v /= 1000 ** scaleCommas
  const decimals = decPat.replace(/[^0#?]/g, '').length
  const minDec = decPat.replace(/[^0]/g, '').length
  const minInt = intPat.replace(/[^0]/g, '').length
  let s = Math.abs(v).toFixed(decimals)
  let [ip, dp = ''] = s.split('.')
  if (dp && minDec < decimals) {
    dp = dp.replace(/0+$/, '')
    if (dp.length < minDec) dp = dp.padEnd(minDec, '0')
  }
  ip = ip.replace(/^0+/, '')
  if (ip.length < minInt) ip = ip.padStart(minInt, '0')
  if (thousands) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  s = ip + (decPat.includes('.') || pattern.includes('.') ? (dp || decimals ? '.' + dp : '.') : '')
  if (s.endsWith('.') && !decimals) s = s.slice(0, -1) + (pattern.endsWith('.') ? '.' : '')
  return prefix + s + suffix
}

function formatFraction(v: number, mixed: boolean, den: string): string {
  const whole = mixed ? Math.floor(v) : 0
  const f = v - whole
  let best = { n: 0, d: 1 }
  if (/^\d+$/.test(den)) {
    const d = +den
    best = { n: Math.round(f * d), d }
  } else {
    const maxD = 10 ** den.length - 1
    let err = Infinity
    for (let d = 1; d <= maxD; d++) {
      const n = Math.round(f * d)
      const e = Math.abs(f - n / d)
      if (e < err - 1e-12) {
        err = e
        best = { n, d }
      }
    }
  }
  if (best.n === best.d && mixed) return String(whole + 1)
  if (best.n === 0) return mixed ? String(whole) : '0'
  return (mixed && whole ? `${whole} ` : '') + `${best.n}/${best.d}`
}

interface Formatted {
  text: string
  color?: string
  /** numbers (and dates) align right under "General" alignment */
  numeric: boolean
}

export function formatValue(v: number, code: string, date1904: boolean): Formatted {
  if (!code || /^general$/i.test(code)) return { text: generalNumber(v), numeric: true }
  const secs = sections(code)
  let sec = secs[0]
  let neg = v < 0
  if (secs.length >= 2) {
    const cond = /\[(<=|>=|<>|<|>|=)(-?[\d.]+)\]/.exec(secs[0])
    if (cond) {
      const n = parseFloat(cond[2])
      const ok = { '<': v < n, '<=': v <= n, '>': v > n, '>=': v >= n, '=': v === n, '<>': v !== n }[cond[1]]
      sec = ok ? secs[0] : secs[1]
      neg = !ok && v < 0 && secs.length < 3
    } else if (v < 0) {
      sec = secs[1]
      neg = false
      v = -v
    } else if (v === 0 && secs.length >= 3) sec = secs[2]
  }
  if (sec === undefined) sec = secs[0]
  let color: string | undefined
  const cm = /\[(red|blue|green|yellow|magenta|cyan|white|black|color\s*\d+)\]/i.exec(sec)
  if (cm) {
    const name = cm[1].toLowerCase()
    color = COLORS[name] ?? (/color\s*(\d+)/.exec(name) ? '#' + (INDEXED[+/(\d+)/.exec(name)![1] + 7] ?? '000000') : undefined)
  }
  if (/^@$/.test(sec.trim()) || /^general$/i.test(sec.replace(/\[[^\]]*\]/g, '').trim()))
    return { text: (neg ? '-' : '') + generalNumber(Math.abs(v)), color, numeric: true }
  if (isDateCode(sec)) return { text: formatDate(v, sec, date1904), color, numeric: true }
  const frac = /([#0?]+\s+)?([#0?]+)\/([#0?]+|\d+)/.exec(sec.replace(/"[^"]*"/g, ''))
  if (frac) return { text: (neg && v !== 0 ? '-' : '') + formatFraction(Math.abs(v), !!frac[1], frac[3]), color, numeric: true }
  const text = formatNumberSection(Math.abs(v), sec)
  return { text: (neg && v !== 0 && /[1-9]/.test(text) ? '-' : '') + text, color, numeric: true }
}

// ---------- styles ----------

interface Font {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  size: number
  color: string | null
  name: string
}
interface Border {
  style: string
  color: string | null
}
interface Xf {
  numFmt: string
  font: Font
  fill: string | null
  border: Record<'left' | 'right' | 'top' | 'bottom', Border | null>
  hAlign: string
  vAlign: string
  wrap: boolean
  indent: number
}

function readStyles(doc: Document | null, theme: Theme): { xfs: Xf[]; defaultFont: Font } {
  const numFmts = new Map<number, string>()
  for (const n of all(doc, 'numFmt')) numFmts.set(+(n.getAttribute('numFmtId') ?? 0), n.getAttribute('formatCode') ?? 'General')
  const fonts: Font[] = kids(kid(doc, 'fonts'), 'font').map((f) => {
    const on = (name: string) => {
      const el = kid(f, name)
      return !!el && el.getAttribute('val') !== '0' && el.getAttribute('val') !== 'false' && el.getAttribute('val') !== 'none'
    }
    return {
      bold: on('b'),
      italic: on('i'),
      underline: on('u'),
      strike: on('strike'),
      size: parseFloat(kid(f, 'sz')?.getAttribute('val') ?? '11') || 11,
      color: theme.color(kid(f, 'color')),
      name: kid(f, 'name')?.getAttribute('val') ?? 'Calibri',
    }
  })
  const defaultFont: Font = fonts[0] ?? { bold: false, italic: false, underline: false, strike: false, size: 11, color: null, name: 'Calibri' }
  const fills: Array<string | null> = kids(kid(doc, 'fills'), 'fill').map((f) => {
    const p = kid(f, 'patternFill')
    if (p) {
      const type = p.getAttribute('patternType')
      if (!type || type === 'none') return null
      if (type === 'solid') return theme.color(kid(p, 'fgColor')) ?? theme.color(kid(p, 'bgColor'))
      // patterns are approximated by their foreground colour, lightened
      const c = theme.color(kid(p, 'fgColor'))
      return c ? applyTint(c.slice(1), 0.5) : null
    }
    const g = kid(f, 'gradientFill')
    if (g) return theme.color(kid(kid(g, 'stop'), 'color'))
    return null
  })
  const borders = kids(kid(doc, 'borders'), 'border').map((b) => {
    const side = (name: string): Border | null => {
      const el = kid(b, name)
      const style = el?.getAttribute('style')
      if (!el || !style || style === 'none') return null
      return { style, color: theme.color(kid(el, 'color')) }
    }
    return { left: side('left') ?? side('start'), right: side('right') ?? side('end'), top: side('top'), bottom: side('bottom') }
  })
  const xfs: Xf[] = kids(kid(doc, 'cellXfs'), 'xf').map((x) => {
    const id = +(x.getAttribute('numFmtId') ?? 0)
    const al = kid(x, 'alignment')
    return {
      numFmt: numFmts.get(id) ?? BUILTIN_FORMATS[id] ?? 'General',
      font: fonts[+(x.getAttribute('fontId') ?? 0)] ?? defaultFont,
      fill: fills[+(x.getAttribute('fillId') ?? 0)] ?? null,
      border: borders[+(x.getAttribute('borderId') ?? 0)] ?? { left: null, right: null, top: null, bottom: null },
      hAlign: al?.getAttribute('horizontal') ?? 'general',
      vAlign: al?.getAttribute('vertical') ?? 'bottom',
      wrap: al?.getAttribute('wrapText') === '1' || al?.getAttribute('wrapText') === 'true',
      indent: +(al?.getAttribute('indent') ?? 0),
    }
  })
  if (!xfs.length)
    xfs.push({
      numFmt: 'General',
      font: defaultFont,
      fill: null,
      border: { left: null, right: null, top: null, bottom: null },
      hAlign: 'general',
      vAlign: 'bottom',
      wrap: false,
      indent: 0,
    })
  return { xfs, defaultFont }
}

// ---------- cells ----------

function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}
function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim())
  return m ? { c: colIndex(m[1]), r: +m[2] } : null
}
function parseRange(ref: string): { r0: number; c0: number; r1: number; c1: number } | null {
  const [a, b] = ref.split(':')
  const p = parseRef(a)
  if (!p) {
    // whole rows ($1:$3) or columns ($A:$C)
    const rows = /^\$?(\d+):\$?(\d+)$/.exec(ref)
    if (rows) return { r0: +rows[1], r1: +rows[2], c0: 1, c1: 16384 }
    const cols = /^\$?([A-Z]+):\$?([A-Z]+)$/i.exec(ref)
    if (cols) return { r0: 1, r1: 1048576, c0: colIndex(cols[1]), c1: colIndex(cols[2]) }
    return null
  }
  const q = b ? parseRef(b) : p
  if (!q) return null
  return { r0: Math.min(p.r, q.r), c0: Math.min(p.c, q.c), r1: Math.max(p.r, q.r), c1: Math.max(p.c, q.c) }
}

interface Cell {
  text: string
  xf: Xf
  numeric: boolean
  color?: string
  runs?: Array<{ text: string; font: Partial<Font> }>
  bool?: boolean
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function readRuns(si: Element, theme: Theme): { text: string; runs?: Cell['runs'] } {
  const rs = kids(si, 'r')
  if (!rs.length) return { text: kids(si, 't').map((t) => t.textContent ?? '').join('') }
  const runs: NonNullable<Cell['runs']> = []
  for (const r of rs) {
    const pr = kid(r, 'rPr')
    const font: Partial<Font> = {}
    if (pr) {
      const b = kid(pr, 'b')
      if (b) font.bold = b.getAttribute('val') !== '0'
      const i = kid(pr, 'i')
      if (i) font.italic = i.getAttribute('val') !== '0'
      const u = kid(pr, 'u')
      if (u) font.underline = u.getAttribute('val') !== 'none'
      const sz = kid(pr, 'sz')
      if (sz) font.size = parseFloat(sz.getAttribute('val') ?? '11')
      const c = theme.color(kid(pr, 'color'))
      if (c) font.color = c
      const name = kid(pr, 'rFont')?.getAttribute('val')
      if (name) font.name = name
    }
    runs.push({ text: kids(r, 't').map((t) => t.textContent ?? '').join(''), font })
  }
  return { text: runs.map((r) => r.text).join(''), runs }
}

const BORDER_CSS: Record<string, [number, string]> = {
  hair: [1, 'solid'],
  thin: [1, 'solid'],
  medium: [2, 'solid'],
  thick: [3, 'solid'],
  double: [3, 'double'],
  dashed: [1, 'dashed'],
  dotted: [1, 'dotted'],
  mediumDashed: [2, 'dashed'],
  dashDot: [1, 'dashed'],
  mediumDashDot: [2, 'dashed'],
  dashDotDot: [1, 'dashed'],
  mediumDashDotDot: [2, 'dashed'],
  slantDashDot: [2, 'dashed'],
}

interface SheetOut {
  section: FlowSection
}

export async function xlsxToPdf(
  data: ArrayBuffer,
  opts: { title?: string; onProgress?: (f: number) => void } = {},
): Promise<OfficeResult> {
  const files = unzipSync(new Uint8Array(data))
  const warnings = new Set<string>()
  const wbPath = 'xl/workbook.xml'
  const wb = xml(files, wbPath)
  if (!wb) throw new Error('this is not an Excel workbook')
  const wbRels = rels(files, wbPath)
  const date1904 = ['1', 'true'].includes(kid(wb, 'workbookPr')?.getAttribute('date1904') ?? '')
  const themePath = [...wbRels.values()].find((p) => /theme\/theme\d*\.xml$/.test(p))
  const theme = new Theme(themePath ? xml(files, themePath) : null)
  const stylesPath = [...wbRels.values()].find((p) => /styles\.xml$/.test(p)) ?? 'xl/styles.xml'
  const { xfs, defaultFont } = readStyles(xml(files, stylesPath), theme)
  const ssPath = [...wbRels.values()].find((p) => /sharedStrings\.xml$/.test(p)) ?? 'xl/sharedStrings.xml'
  const shared = all(xml(files, ssPath), 'si').map((si) => readRuns(si, theme))

  const printAreas = new Map<number, string>()
  for (const dn of all(wb, 'definedName')) {
    if (dn.getAttribute('name') !== '_xlnm.Print_Area') continue
    const local = dn.getAttribute('localSheetId')
    if (local !== null) printAreas.set(+local, (dn.textContent ?? '').split(',')[0])
  }

  const host = makeHost()
  try {
    const out: SheetOut[] = []
    const sheetEls = all(wb, 'sheet')
    for (const [si, sheetEl] of sheetEls.entries()) {
      const state = sheetEl.getAttribute('state')
      if (state === 'hidden' || state === 'veryHidden') continue
      const rid = sheetEl.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? sheetEl.getAttribute('r:id') ?? ''
      const path = wbRels.get(rid)
      if (!path) continue
      const doc = xml(files, path)
      if (!doc) continue
      const sheet = renderSheet(doc, path, files, {
        theme,
        xfs,
        defaultFont,
        shared,
        date1904,
        printArea: printAreas.get(si)?.replace(/^.*!/, ''),
        warnings,
        host,
      })
      if (sheet) out.push(sheet)
      opts.onProgress?.(((si + 1) / sheetEls.length) * 0.2)
    }
    if (!out.length) throw new Error('this workbook has no cells with content to convert')
    await settle(host)
    const bytes = await domToPdf(
      out.map((o) => o.section),
      { scale: 0.75, title: opts.title, onProgress: (f) => opts.onProgress?.(0.2 + f * 0.8) },
    )
    return { bytes, warnings: [...warnings] }
  } finally {
    host.remove()
  }
}

interface RenderCtx {
  theme: Theme
  xfs: Xf[]
  defaultFont: Font
  shared: Array<{ text: string; runs?: Cell['runs'] }>
  date1904: boolean
  printArea?: string
  warnings: Set<string>
  host: HTMLElement
}

function renderSheet(doc: Document, path: string, files: Files, ctx: RenderCtx): SheetOut | null {
  const ws = doc.documentElement
  const fmtPr = kid(ws, 'sheetFormatPr')
  const defaultRowPt = parseFloat(fmtPr?.getAttribute('defaultRowHeight') ?? '') || 15
  const MDW = 7
  const defaultColW = fmtPr?.getAttribute('defaultColWidth')
    ? Math.round(parseFloat(fmtPr.getAttribute('defaultColWidth')!) * MDW + 5)
    : Math.ceil(((parseFloat(fmtPr?.getAttribute('baseColWidth') ?? '8') || 8) * MDW + 5) / 8) * 8

  const colW = new Map<number, number>()
  const colHidden = new Set<number>()
  for (const c of kids(kid(ws, 'cols'), 'col')) {
    const min = +(c.getAttribute('min') ?? 1)
    const max = Math.min(+(c.getAttribute('max') ?? min), 16384)
    const w = parseFloat(c.getAttribute('width') ?? '')
    for (let i = min; i <= max && i <= min + 2000; i++) {
      if (c.getAttribute('hidden') === '1' || c.getAttribute('hidden') === 'true') colHidden.add(i)
      if (!Number.isNaN(w)) colW.set(i, Math.round(w * MDW))
    }
  }
  const widthOf = (c: number) => (colHidden.has(c) ? 0 : (colW.get(c) ?? defaultColW))

  const rowH = new Map<number, number>()
  const rowHidden = new Set<number>()
  const cells = new Map<number, Map<number, Cell>>()
  let maxR = 0
  let maxC = 0
  let minR = Infinity
  let minC = Infinity
  let noCache = false
  for (const row of kids(kid(ws, 'sheetData'), 'row')) {
    const r = +(row.getAttribute('r') ?? 0)
    if (!r) continue
    const ht = parseFloat(row.getAttribute('ht') ?? '')
    if (!Number.isNaN(ht)) rowH.set(r, ht * (4 / 3))
    if (row.getAttribute('hidden') === '1' || row.getAttribute('hidden') === 'true') rowHidden.add(r)
    for (const c of kids(row, 'c')) {
      const ref = parseRef(c.getAttribute('r') ?? '')
      if (!ref) continue
      const xf = ctx.xfs[+(c.getAttribute('s') ?? 0)] ?? ctx.xfs[0]
      const t = c.getAttribute('t') ?? 'n'
      const v = kid(c, 'v')?.textContent ?? null
      let cell: Cell | null = null
      if (t === 's' && v !== null) {
        const s = ctx.shared[+v]
        if (s) cell = { text: s.text, runs: s.runs, xf, numeric: false }
      } else if (t === 'inlineStr') {
        const is = kid(c, 'is')
        if (is) cell = { ...readRuns(is, ctx.theme), xf, numeric: false }
      } else if (t === 'str' && v !== null) cell = { text: v, xf, numeric: false }
      else if (t === 'b' && v !== null) cell = { text: v === '1' ? 'TRUE' : 'FALSE', xf, numeric: false, bool: true }
      else if (t === 'e' && v !== null) cell = { text: v, xf, numeric: false, bool: true }
      else if (t === 'd' && v !== null) cell = { text: v, xf, numeric: false }
      else if (v !== null && v !== '') {
        const n = parseFloat(v)
        if (!Number.isNaN(n)) {
          const f = /@/.test(xf.numFmt) && !/[0#?]/.test(xf.numFmt) ? { text: v, numeric: false } : formatValue(n, xf.numFmt, ctx.date1904)
          cell = { text: f.text, xf, numeric: f.numeric, color: 'color' in f ? f.color : undefined }
        }
      } else if (kid(c, 'f')) noCache = true
      const styled = !cell && (xf.fill || xf.border.top || xf.border.bottom || xf.border.left || xf.border.right)
      if (!cell && styled) cell = { text: '', xf, numeric: false }
      if (!cell) continue
      let rowMap = cells.get(ref.r)
      if (!rowMap) cells.set(ref.r, (rowMap = new Map()))
      rowMap.set(ref.c, cell)
      if (cell.text !== '') {
        maxR = Math.max(maxR, ref.r)
        maxC = Math.max(maxC, ref.c)
        minR = Math.min(minR, ref.r)
        minC = Math.min(minC, ref.c)
      }
    }
  }
  if (noCache) ctx.warnings.add('formulas')

  const merges: Array<{ r0: number; c0: number; r1: number; c1: number }> = []
  for (const m of kids(kid(ws, 'mergeCells'), 'mergeCell')) {
    const rg = parseRange(m.getAttribute('ref') ?? '')
    if (rg) merges.push(rg)
  }

  // Pictures (and a note about charts).
  const pictures: Array<{ src: string; from: { c: number; cOff: number; r: number; rOff: number }; to?: { c: number; cOff: number; r: number; rOff: number }; ext?: { w: number; h: number } }> = []
  const sheetRels = rels(files, path)
  for (const d of kids(ws, 'drawing')) {
    const rid = d.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? ''
    const dpath = sheetRels.get(rid)
    const ddoc = dpath ? xml(files, dpath) : null
    if (!ddoc || !dpath) continue
    const drels = rels(files, dpath)
    for (const anchor of [...kids(ddoc, 'twoCellAnchor'), ...kids(ddoc, 'oneCellAnchor')]) {
      if (all(anchor, 'chart').length) ctx.warnings.add('charts')
      const pic = all(anchor, 'pic')[0]
      const blip = pic ? all(pic, 'blip')[0] : null
      const embed = blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
      const media = embed ? drels.get(embed) : undefined
      if (!media || !files[media]) continue
      const pos = (el: Element | null) =>
        el
          ? {
              c: +(kid(el, 'col')?.textContent ?? 0) + 1,
              cOff: +(kid(el, 'colOff')?.textContent ?? 0) / EMU_PER_PX,
              r: +(kid(el, 'row')?.textContent ?? 0) + 1,
              rOff: +(kid(el, 'rowOff')?.textContent ?? 0) / EMU_PER_PX,
            }
          : null
      const from = pos(kid(anchor, 'from'))
      if (!from) continue
      const to = pos(kid(anchor, 'to')) ?? undefined
      const extEl = kid(anchor, 'ext')
      const ext = extEl ? { w: +(extEl.getAttribute('cx') ?? 0) / EMU_PER_PX, h: +(extEl.getAttribute('cy') ?? 0) / EMU_PER_PX } : undefined
      const ext2 = media.split('.').pop()!.toLowerCase()
      if (/^(emf|wmf)$/.test(ext2)) {
        ctx.warnings.add('emf')
        continue
      }
      const mime = ext2 === 'png' ? 'image/png' : /jpe?g/.test(ext2) ? 'image/jpeg' : ext2 === 'gif' ? 'image/gif' : ext2 === 'svg' ? 'image/svg+xml' : `image/${ext2}`
      const url = URL.createObjectURL(new Blob([files[media] as BlobPart], { type: mime }))
      pictures.push({ src: url, from, to, ext })
      maxR = Math.max(maxR, to?.r ?? from.r)
      maxC = Math.max(maxC, to?.c ?? from.c)
      minR = Math.min(minR, from.r)
      minC = Math.min(minC, from.c)
    }
  }

  let area = ctx.printArea ? parseRange(ctx.printArea) : null
  if (!area) {
    if (!Number.isFinite(minR)) return null
    for (const m of merges) {
      if (m.r0 <= maxR && m.r1 >= minR && m.c0 <= maxC && m.c1 >= minC) {
        maxR = Math.max(maxR, m.r1)
        maxC = Math.max(maxC, m.c1)
      }
    }
    // Excel prints from A1 when the content starts near it.
    area = { r0: minR <= 3 ? 1 : minR, c0: minC <= 3 ? 1 : minC, r1: maxR, c1: maxC }
  }
  area.r1 = Math.min(area.r1, area.r0 + 20000)
  area.c1 = Math.min(area.c1, area.c0 + 400)

  // Page setup.
  const setup = kid(ws, 'pageSetup')
  const fitToPage = kid(kid(ws, 'sheetPr'), 'pageSetUpPr')?.getAttribute('fitToPage') === '1'
  const margins = kid(ws, 'pageMargins')
  const inch = (name: string, d: number) => (parseFloat(margins?.getAttribute(name) ?? '') || d) * 96
  const paper = +(setup?.getAttribute('paperSize') ?? 1)
  const PAPERS: Record<number, [number, number]> = { 1: [816, 1056], 5: [816, 1344], 9: [793.7, 1122.5], 8: [1122.5, 1587.4], 11: [559.4, 793.7], 3: [1056, 1632] }
  let [pw, ph] = PAPERS[paper] ?? PAPERS[1]
  let orientation = setup?.getAttribute('orientation')
  const ml = inch('left', 0.7)
  const mr = inch('right', 0.7)
  const mt = inch('top', 0.75)
  const mb = inch('bottom', 0.75)
  const gridLines = ['1', 'true'].includes(kid(ws, 'printOptions')?.getAttribute('gridLines') ?? '')
  const centered = ['1', 'true'].includes(kid(ws, 'printOptions')?.getAttribute('horizontalCentered') ?? '')

  const colsList: number[] = []
  for (let c = area.c0; c <= area.c1; c++) if (!colHidden.has(c)) colsList.push(c)
  const rowsList: number[] = []
  for (let r = area.r0; r <= area.r1; r++) if (!rowHidden.has(r)) rowsList.push(r)
  const tableW = colsList.reduce((s, c) => s + widthOf(c), 0)
  const heightOf = (r: number) => rowH.get(r) ?? defaultRowPt * (4 / 3)
  const tableH = rowsList.reduce((s, r) => s + heightOf(r), 0)

  // Too wide for portrait: turn the page rather than shrink the text a lot
  // (unless the file asks for an exact fit).
  const baseScale = (parseFloat(setup?.getAttribute('scale') ?? '100') || 100) / 100
  if (orientation !== 'landscape' && !fitToPage && tableW * baseScale > (pw - ml - mr) / 0.8) orientation = 'landscape'
  if (orientation === 'landscape') [pw, ph] = [ph, pw]
  const bodyW = pw - ml - mr
  const bodyH = ph - mt - mb
  let scale = (parseFloat(setup?.getAttribute('scale') ?? '100') || 100) / 100
  if (fitToPage) {
    const fw = +(setup?.getAttribute('fitToWidth') ?? 1)
    const fh = +(setup?.getAttribute('fitToHeight') ?? 1)
    let s = 1
    if (fw > 0) s = Math.min(s, (bodyW * fw) / tableW)
    if (fh > 0) s = Math.min(s, (bodyH * fh) / tableH)
    scale = s
  }
  if (tableW * scale > bodyW) scale = bodyW / tableW
  scale = Math.max(0.1, Math.min(4, scale))
  const S = (v: number) => +(v * scale).toFixed(3)

  // Merges: anchor → span; covered cells skipped.
  const covered = new Set<string>()
  const spans = new Map<string, { rs: number; cs: number }>()
  for (const m of merges) {
    if (m.r1 < area.r0 || m.r0 > area.r1 || m.c1 < area.c0 || m.c0 > area.c1) continue
    const r0 = Math.max(m.r0, area.r0)
    const c0 = Math.max(m.c0, area.c0)
    const rs = rowsList.filter((r) => r >= r0 && r <= Math.min(m.r1, area.r1)).length
    const cs = colsList.filter((c) => c >= c0 && c <= Math.min(m.c1, area.c1)).length
    spans.set(`${r0}:${c0}`, { rs: Math.max(1, rs), cs: Math.max(1, cs) })
    for (let r = r0; r <= m.r1; r++) for (let c = c0; c <= m.c1; c++) if (r !== r0 || c !== c0) covered.add(`${r}:${c}`)
  }
  const cellAt = (r: number, c: number) => cells.get(r)?.get(c)
  const isEmpty = (r: number, c: number) => {
    const x = cellAt(r, c)
    return (!x || x.text === '') && !covered.has(`${r}:${c}`) && !spans.has(`${r}:${c}`)
  }

  const fontCss = (f: Partial<Font>, base: Font) => {
    const name = f.name ?? base.name
    const parts = [
      `font-family:${cssStack(mapFamily(name))}`,
      `font-size:${S(((f.size ?? base.size) * 4) / 3)}px`,
    ]
    if (f.bold ?? base.bold) parts.push('font-weight:700')
    if (f.italic ?? base.italic) parts.push('font-style:italic')
    const dec = [(f.underline ?? base.underline) ? 'underline' : '', (f.strike ?? base.strike) ? 'line-through' : ''].filter(Boolean).join(' ')
    if (dec) parts.push(`text-decoration:${dec}`)
    const color = f.color ?? base.color
    if (color) parts.push(`color:${color}`)
    return parts.join(';')
  }

  const borderCss = (b: Border | null, side: string, grid: boolean) => {
    if (b) {
      const [w, style] = BORDER_CSS[b.style] ?? [1, 'solid']
      return `border-${side}:${Math.max(1, S(w))}px ${style} ${b.color ?? '#000'};`
    }
    return grid ? `border-${side}:1px solid #b4b4b4;` : ''
  }

  const html: string[] = []
  html.push(`<colgroup>${colsList.map((c) => `<col style="width:${S(widthOf(c))}px">`).join('')}</colgroup>`)
  for (const r of rowsList) {
    html.push(`<tr style="height:${S(heightOf(r))}px">`)
    for (const [ci, c] of colsList.entries()) {
      const key = `${r}:${c}`
      if (covered.has(key)) continue
      const span = spans.get(key)
      const cell = cellAt(r, c)
      const xf = cell?.xf ?? ctx.xfs[0]
      const st: string[] = ['padding:0', `vertical-align:${xf.vAlign === 'center' ? 'middle' : xf.vAlign === 'top' ? 'top' : 'bottom'}`]
      if (xf.fill) st.push(`background:${xf.fill}`)
      const b = xf.border
      st.push(borderCss(b.top, 'top', gridLines) + borderCss(b.bottom, 'bottom', gridLines) + borderCss(b.left, 'left', gridLines) + borderCss(b.right, 'right', gridLines))
      const attrs = span ? `${span.rs > 1 ? ` rowspan="${span.rs}"` : ''}${span.cs > 1 ? ` colspan="${span.cs}"` : ''}` : ''
      if (!cell || cell.text === '') {
        html.push(`<td${attrs} style="${st.join(';')}"></td>`)
        continue
      }
      let align = xf.hAlign
      if (align === 'general') align = cell.numeric ? 'right' : cell.bool ? 'center' : 'left'
      if (align === 'centerContinuous' || align === 'distributed') align = 'center'
      if (align === 'fill' || align === 'justify') align = 'left'
      const pad = S(2 + xf.indent * 9)
      const textColor = cell.color
      const inner = cell.runs
        ? cell.runs.map((run) => `<span style="${fontCss(run.font, xf.font)}">${esc(run.text)}</span>`).join('')
        : esc(cell.text)
      const font = fontCss(textColor ? { color: textColor } : {}, xf.font)
      if (xf.wrap || span) {
        st.push(`text-align:${align}`, `padding:0 ${pad}px`, xf.wrap ? 'white-space:pre-wrap;overflow-wrap:anywhere' : 'white-space:pre', 'overflow:hidden', font)
        html.push(`<td${attrs} style="${st.join(';')}">${inner}</td>`)
        continue
      }
      // Unwrapped text spills into empty neighbours, as in Excel; numbers
      // and text with a neighbour in the way are clipped to the cell.
      const leftFree = ci > 0 && isEmpty(r, colsList[ci - 1])
      const rightFree = ci < colsList.length - 1 && isEmpty(r, colsList[ci + 1])
      const spill = !cell.numeric && ((align === 'left' && rightFree) || (align === 'right' && leftFree) || (align === 'center' && leftFree && rightFree))
      st.push('position:relative', font)
      if (!spill) st.push('overflow:hidden')
      const vpos = xf.vAlign === 'top' ? 'top:0' : xf.vAlign === 'center' ? 'top:0;bottom:0;display:flex;align-items:center' : 'bottom:0'
      const hpos =
        align === 'left'
          ? `left:${pad}px`
          : align === 'right'
            ? `right:${pad}px`
            : `left:-2000px;right:-2000px;text-align:center${xf.vAlign === 'center' ? ';justify-content:center' : ''}`
      html.push(`<td${attrs} style="${st.join(';')}"><div style="position:absolute;white-space:pre;${hpos};${vpos}">${inner}</div></td>`)
    }
    html.push('</tr>')
  }

  const page = document.createElement('div')
  page.style.cssText = `position:relative;width:${pw}px;min-height:${ph}px;box-sizing:border-box;padding:${mt}px ${mr}px ${mb}px ${ml}px;background:#fff`
  const wrap = document.createElement('div')
  wrap.style.cssText = `position:relative;width:${S(tableW)}px;${centered ? 'margin:0 auto' : ''}`
  const table = document.createElement('table')
  table.style.cssText = `border-collapse:collapse;table-layout:fixed;width:${S(tableW)}px;${fontCss({}, ctx.defaultFont)}`
  table.innerHTML = html.join('')
  wrap.appendChild(table)

  // Place pictures by their cell anchors.
  const colLeft = (c: number) => {
    let x = 0
    for (let i = area!.c0; i < c; i++) x += widthOf(i)
    return x
  }
  const rowTop = (r: number) => {
    let y = 0
    for (let i = area!.r0; i < r; i++) if (!rowHidden.has(i)) y += heightOf(i)
    return y
  }
  for (const p of pictures) {
    const x0 = colLeft(p.from.c) + p.from.cOff
    const y0 = rowTop(p.from.r) + p.from.rOff
    const w = p.to ? colLeft(p.to.c) + p.to.cOff - x0 : (p.ext?.w ?? 0)
    const h = p.to ? rowTop(p.to.r) + p.to.rOff - y0 : (p.ext?.h ?? 0)
    if (w <= 0 || h <= 0) continue
    const img = document.createElement('img')
    img.src = p.src
    img.style.cssText = `position:absolute;left:${S(x0)}px;top:${S(y0)}px;width:${S(w)}px;height:${S(h)}px`
    wrap.appendChild(img)
  }
  page.appendChild(wrap)
  ctx.host.appendChild(page)

  return {
    section: {
      el: page,
      pageWidth: pw,
      pageHeight: ph,
      bodyTop: mt,
      bodyBottom: mb,
      atomic: [...table.rows],
    },
  }
}

/**
 * PowerPoint (.pptx) → PDF. Each slide is rebuilt as positioned HTML — with
 * the master → layout → slide inheritance PowerPoint uses for placeholder
 * positions, text styles, bullets and backgrounds — then drawn by dom-to-pdf
 * as a real PDF page (vector shapes, embedded pictures, selectable text).
 *
 * Covered: theme colours and fonts (with lumMod/tint/shade…), preset and
 * custom shapes, rotation and flips, pictures with cropping, groups, tables
 * with their table style, connectors with arrowheads, slide backgrounds
 * (solid, gradient, picture), bullets and numbering, autofit text scaling,
 * hyperlinks, slide numbers, and SmartArt's pre-drawn shapes. Charts, video
 * and EMF/WMF pictures are left out (the user is told).
 */
import { unzipSync } from 'fflate'
import { domToPdf, type FlowSection } from './dom-to-pdf'
import { cssStack, mapFamily, mapSymbolText } from './office-fonts'
import { counterText, makeHost, settle, type OfficeResult } from './office-common'
import { all, externalRels, kid, kids, rAttr, rels, xml, type Files } from './ooxml'

const EMU_PX = 9525
const px = (emu: string | null | undefined, d = 0) => (emu == null || emu === '' ? d : +emu / EMU_PX)

// ---------- colour ----------

interface Theme {
  colors: Record<string, string>
  major: string
  minor: string
  lnWidths: number[]
}

function readTheme(doc: Document | null): Theme {
  const t: Theme = {
    colors: {
      dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6',
      accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000',
      accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72',
    },
    major: 'Calibri Light',
    minor: 'Calibri',
    lnWidths: [9525, 25400, 38100],
  }
  const scheme = all(doc, 'clrScheme')[0]
  if (scheme)
    for (const c of scheme.children) {
      const v = c.firstElementChild
      const val = v?.getAttribute('lastClr') ?? v?.getAttribute('val')
      if (val && /^[0-9a-f]{6}$/i.test(val)) t.colors[c.localName] = val.toUpperCase()
    }
  const fs = all(doc, 'fontScheme')[0]
  const major = kid(kid(fs, 'majorFont'), 'latin')?.getAttribute('typeface')
  const minor = kid(kid(fs, 'minorFont'), 'latin')?.getAttribute('typeface')
  if (major) t.major = major
  if (minor) t.minor = minor
  const ln = all(doc, 'lnStyleLst')[0]
  if (ln) t.lnWidths = kids(ln, 'ln').map((l) => +(l.getAttribute('w') ?? 9525))
  return t
}

const PRESET: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00',
  gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', navy: '000080',
  silver: 'C0C0C0', maroon: '800000', purple: '800080', teal: '008080', cyan: '00FFFF', magenta: 'FF00FF',
}

interface Color {
  r: number
  g: number
  b: number
  a: number
}

function hsl(c: Color): [number, number, number] {
  const { r, g, b } = c
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
function fromHsl(h: number, s: number, l: number, a: number): Color {
  if (s === 0) return { r: l, g: l, b: l, a }
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
  return { r: f(h + 1 / 3), g: f(h), b: f(h - 1 / 3), a }
}
const cssColor = (c: Color) =>
  `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${+c.a.toFixed(3)})`
const clamp = (v: number) => Math.max(0, Math.min(1, v))

// ---------- parts ----------

interface Part {
  path: string
  doc: Document
  rels: Map<string, string>
  ext: Map<string, string>
}

interface Ctx {
  files: Files
  theme: Theme
  clrMap: Record<string, string>
  warnings: Set<string>
  slideNo: number
  /** placeholder colour for style references */
  phClr?: Color
  urls: string[]
  tableStyles: Document | null
}

function part(files: Files, path: string): Part | null {
  const doc = xml(files, path)
  if (!doc) return null
  return { path, doc, rels: rels(files, path), ext: externalRels(files, path) }
}

function colorOf(el: Element | null | undefined, ctx: Ctx): Color | null {
  if (!el) return null
  let base: Color | null = null
  const hex = (v: string) => ({ r: parseInt(v.slice(0, 2), 16) / 255, g: parseInt(v.slice(2, 4), 16) / 255, b: parseInt(v.slice(4, 6), 16) / 255, a: 1 })
  switch (el.localName) {
    case 'srgbClr':
      base = hex(el.getAttribute('val') ?? '000000')
      break
    case 'sysClr':
      base = hex(el.getAttribute('lastClr') ?? (el.getAttribute('val') === 'window' ? 'FFFFFF' : '000000'))
      break
    case 'prstClr':
      base = hex(PRESET[el.getAttribute('val') ?? ''] ?? '000000')
      break
    case 'scrgbClr':
      base = { r: +(el.getAttribute('r') ?? 0) / 100000, g: +(el.getAttribute('g') ?? 0) / 100000, b: +(el.getAttribute('b') ?? 0) / 100000, a: 1 }
      break
    case 'hslClr':
      base = fromHsl(+(el.getAttribute('hue') ?? 0) / 21600000, +(el.getAttribute('sat') ?? 0) / 100000, +(el.getAttribute('lum') ?? 0) / 100000, 1)
      break
    case 'schemeClr': {
      const v = el.getAttribute('val') ?? 'tx1'
      if (v === 'phClr') base = ctx.phClr ? { ...ctx.phClr } : hex('000000')
      else {
        const mapped = ctx.clrMap[v] ?? v
        base = hex(ctx.theme.colors[mapped] ?? ctx.theme.colors[v] ?? '000000')
      }
      break
    }
    default:
      return null
  }
  for (const m of el.children) {
    const val = +(m.getAttribute('val') ?? 0) / 100000
    switch (m.localName) {
      case 'alpha':
        base.a = val
        break
      case 'alphaMod':
        base.a *= val
        break
      case 'lumMod': {
        const [h, s, l] = hsl(base)
        base = fromHsl(h, s, clamp(l * val), base.a)
        break
      }
      case 'lumOff': {
        const [h, s, l] = hsl(base)
        base = fromHsl(h, s, clamp(l + val), base.a)
        break
      }
      case 'satMod': {
        const [h, s, l] = hsl(base)
        base = fromHsl(h, clamp(s * val), l, base.a)
        break
      }
      case 'tint':
        base = { r: base.r * val + (1 - val), g: base.g * val + (1 - val), b: base.b * val + (1 - val), a: base.a }
        break
      case 'shade':
        base = { r: base.r * val, g: base.g * val, b: base.b * val, a: base.a }
        break
      case 'inv':
        base = { r: 1 - base.r, g: 1 - base.g, b: 1 - base.b, a: base.a }
        break
      case 'gray': {
        const y: number = 0.299 * base.r + 0.587 * base.g + 0.114 * base.b
        base = { r: y, g: y, b: y, a: base.a }
        break
      }
    }
  }
  return base
}

/** First colour element inside `el` (e.g. a solidFill). */
const colorIn = (el: Element | null | undefined, ctx: Ctx) => (el?.firstElementChild ? colorOf(el.firstElementChild, ctx) : null)

type Fill =
  | { kind: 'none' }
  | { kind: 'solid'; color: Color }
  | { kind: 'grad'; stops: Array<{ pos: number; color: Color }>; angle: number; path: boolean }
  | { kind: 'image'; src: string }

function fillOf(container: Element | null | undefined, ctx: Ctx, p: Part): Fill | null {
  if (!container) return null
  for (const c of container.children) {
    switch (c.localName) {
      case 'noFill':
        return { kind: 'none' }
      case 'solidFill': {
        const color = colorIn(c, ctx)
        return color ? { kind: 'solid', color } : null
      }
      case 'gradFill': {
        const stops = kids(kid(c, 'gsLst'), 'gs')
          .map((g) => ({ pos: +(g.getAttribute('pos') ?? 0) / 100000, color: colorIn(g, ctx) }))
          .filter((s): s is { pos: number; color: Color } => !!s.color)
          .sort((a, b) => a.pos - b.pos)
        if (!stops.length) return null
        const lin = kid(c, 'lin')
        return { kind: 'grad', stops, angle: +(lin?.getAttribute('ang') ?? 5400000) / 60000, path: !!kid(c, 'path') }
      }
      case 'pattFill': {
        const color = colorIn(kid(c, 'fgClr'), ctx)
        return color ? { kind: 'solid', color } : null
      }
      case 'blipFill': {
        const src = blipUrl(c, ctx, p)
        return src ? { kind: 'image', src } : null
      }
    }
  }
  return null
}

function blipUrl(blipFill: Element, ctx: Ctx, p: Part): string | null {
  const blip = kid(blipFill, 'blip')
  const id = rAttr(blip, 'embed')
  const path = id ? p.rels.get(id) : undefined
  if (!path || !ctx.files[path]) return null
  const ext = path.split('.').pop()!.toLowerCase()
  if (ext === 'emf' || ext === 'wmf' || ext === 'tif' || ext === 'tiff') {
    ctx.warnings.add('emf')
    return null
  }
  const mime = ext === 'png' ? 'image/png' : /jpe?g/.test(ext) ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`
  const url = URL.createObjectURL(new Blob([ctx.files[path] as BlobPart], { type: mime }))
  ctx.urls.push(url)
  return url
}

const avg = (stops: Array<{ color: Color }>): Color => {
  const n = stops.length
  return stops.reduce((a, s) => ({ r: a.r + s.color.r / n, g: a.g + s.color.g / n, b: a.b + s.color.b / n, a: a.a + s.color.a / n }), { r: 0, g: 0, b: 0, a: 0 })
}

/** A gradient as a picture (dom-to-pdf draws pictures, not CSS gradients). */
function gradientImage(f: Extract<Fill, { kind: 'grad' }>, w: number, h: number): string {
  const c = document.createElement('canvas')
  const s = Math.min(1, 512 / Math.max(w, h, 1))
  c.width = Math.max(2, Math.round(w * s))
  c.height = Math.max(2, Math.round(h * s))
  const g = c.getContext('2d')!
  let grad: CanvasGradient
  if (f.path) {
    const r = Math.hypot(c.width, c.height) / 2
    grad = g.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, r)
  } else {
    const a = (f.angle * Math.PI) / 180
    const cx = c.width / 2
    const cy = c.height / 2
    const len = Math.abs(c.width * Math.cos(a)) / 2 + Math.abs(c.height * Math.sin(a)) / 2
    grad = g.createLinearGradient(cx - Math.cos(a) * len, cy - Math.sin(a) * len, cx + Math.cos(a) * len, cy + Math.sin(a) * len)
  }
  for (const st of f.stops) grad.addColorStop(clamp(st.pos), cssColor(st.color))
  g.fillStyle = grad
  g.fillRect(0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}

// ---------- geometry ----------

type Cmd =
  | { c: 'M' | 'L'; p: [number, number] }
  | { c: 'C'; p1: [number, number]; p2: [number, number]; p: [number, number] }
  | { c: 'Q'; p1: [number, number]; p: [number, number] }
  | { c: 'A'; rx: number; ry: number; rot: number; large: number; sweep: number; p: [number, number] }
  | { c: 'Z' }

function ellipseCmds(x: number, y: number, w: number, h: number): Cmd[] {
  const rx = w / 2
  const ry = h / 2
  return [
    { c: 'M', p: [x, y + ry] },
    { c: 'A', rx, ry, rot: 0, large: 1, sweep: 1, p: [x + w, y + ry] },
    { c: 'A', rx, ry, rot: 0, large: 1, sweep: 1, p: [x, y + ry] },
    { c: 'Z' },
  ]
}
const poly = (pts: Array<[number, number]>, close = true): Cmd[] => [
  { c: 'M', p: pts[0] },
  ...pts.slice(1).map((p) => ({ c: 'L' as const, p })),
  ...(close ? [{ c: 'Z' as const }] : []),
]

function adjOf(geom: Element | null): Map<string, number> {
  const m = new Map<string, number>()
  for (const gd of kids(kid(geom, 'avLst'), 'gd')) {
    const f = /val\s+(-?\d+)/.exec(gd.getAttribute('fmla') ?? '')
    if (f) m.set(gd.getAttribute('name') ?? '', +f[1])
  }
  return m
}

/** Preset shape outlines. Returns null for shapes we don't know. */
function presetCmds(prst: string, w: number, h: number, adj: Map<string, number>): { cmds: Cmd[]; open?: boolean } | null {
  const ss = Math.min(w, h)
  const a = (name: string, d: number) => (adj.get(name) ?? adj.get(name === 'adj' ? 'adj1' : 'adj') ?? d) / 100000
  switch (prst) {
    case 'rect':
    case 'flowChartProcess':
    case 'flowChartPredefinedProcess':
    case 'flowChartInternalStorage':
    case 'wedgeRectCallout':
    case 'can':
    case 'cube':
    case 'bevel':
    case 'frame':
    case 'foldedCorner':
    case 'plaque':
      return { cmds: poly([[0, 0], [w, 0], [w, h], [0, h]]) }
    case 'roundRect':
    case 'flowChartAlternateProcess':
    case 'wedgeRoundRectCallout':
    case 'flowChartTerminator': {
      const r = prst === 'flowChartTerminator' ? ss / 2 : ss * a('adj', 16667)
      return { cmds: roundCmds(w, h, [r, r, r, r]) }
    }
    case 'round1Rect': {
      const r = ss * a('adj', 16667)
      return { cmds: roundCmds(w, h, [0, r, 0, 0]) }
    }
    case 'round2SameRect': {
      const r = ss * a('adj1', 16667)
      return { cmds: roundCmds(w, h, [r, r, 0, 0]) }
    }
    case 'round2DiagRect': {
      const r = ss * a('adj1', 16667)
      return { cmds: roundCmds(w, h, [r, 0, r, 0]) }
    }
    case 'snip1Rect': {
      const d = ss * a('adj', 16667)
      return { cmds: poly([[0, 0], [w - d, 0], [w, d], [w, h], [0, h]]) }
    }
    case 'snip2SameRect': {
      const d = ss * a('adj1', 16667)
      return { cmds: poly([[d, 0], [w - d, 0], [w, d], [w, h], [0, h], [0, d]]) }
    }
    case 'ellipse':
    case 'flowChartConnector':
    case 'wedgeEllipseCallout':
    case 'donut':
    case 'cloud':
    case 'cloudCallout':
    case 'teardrop':
    case 'smileyFace':
    case 'flowChartOnlineStorage':
      return { cmds: ellipseCmds(0, 0, w, h) }
    case 'triangle':
    case 'flowChartExtract': {
      const x = w * a('adj', 50000)
      return { cmds: poly([[x, 0], [w, h], [0, h]]) }
    }
    case 'flowChartMerge':
      return { cmds: poly([[0, 0], [w, 0], [w / 2, h]]) }
    case 'rtTriangle':
      return { cmds: poly([[0, 0], [w, h], [0, h]]) }
    case 'diamond':
    case 'flowChartDecision':
      return { cmds: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) }
    case 'parallelogram':
    case 'flowChartInputOutput': {
      const d = prst === 'parallelogram' ? ss * a('adj', 25000) : w / 5
      return { cmds: poly([[d, 0], [w, 0], [w - d, h], [0, h]]) }
    }
    case 'trapezoid':
    case 'flowChartManualOperation': {
      const d = prst === 'trapezoid' ? ss * a('adj', 25000) : w / 5
      return { cmds: poly([[0, 0], [w, 0], [w - d, h], [d, h]]) }
    }
    case 'pentagon':
      return { cmds: poly([[w / 2, 0], [w, h * 0.382], [w * 0.809, h], [w * 0.191, h], [0, h * 0.382]]) }
    case 'hexagon': {
      const d = ss * a('adj', 25000)
      return { cmds: poly([[d, 0], [w - d, 0], [w, h / 2], [w - d, h], [d, h], [0, h / 2]]) }
    }
    case 'octagon': {
      const d = ss * a('adj', 29289)
      return { cmds: poly([[d, 0], [w - d, 0], [w, d], [w, h - d], [w - d, h], [d, h], [0, h - d], [0, d]]) }
    }
    case 'homePlate':
    case 'flowChartOffpageConnector': {
      const d = prst === 'homePlate' ? ss * a('adj', 50000) : h / 5
      return prst === 'homePlate'
        ? { cmds: poly([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h]]) }
        : { cmds: poly([[0, 0], [w, 0], [w, h - d], [w / 2, h], [0, h - d]]) }
    }
    case 'chevron': {
      const d = ss * a('adj', 50000)
      return { cmds: poly([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h], [d, h / 2]]) }
    }
    case 'rightArrow':
    case 'leftArrow':
    case 'upArrow':
    case 'downArrow': {
      const horiz = prst === 'rightArrow' || prst === 'leftArrow'
      const L = horiz ? w : h
      const T = horiz ? h : w
      const shaft = T * a('adj1', 50000)
      const head = Math.min(L, ss * a('adj2', 50000))
      const s0 = (T - shaft) / 2
      let pts: Array<[number, number]> = [[0, s0], [L - head, s0], [L - head, 0], [L, T / 2], [L - head, T], [L - head, T - s0], [0, T - s0]]
      if (prst === 'leftArrow' || prst === 'upArrow') pts = pts.map(([x, y]) => [L - x, y])
      if (!horiz) pts = pts.map(([x, y]) => [y, x])
      return { cmds: poly(pts) }
    }
    case 'leftRightArrow': {
      const shaft = h * a('adj1', 50000)
      const head = Math.min(w / 2, ss * a('adj2', 50000))
      const s0 = (h - shaft) / 2
      return { cmds: poly([[0, h / 2], [head, 0], [head, s0], [w - head, s0], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h - s0], [head, h - s0], [head, h]]) }
    }
    case 'plus':
    case 'mathPlus': {
      const d = ss * a('adj', 25000)
      return { cmds: poly([[d, 0], [w - d, 0], [w - d, d], [w, d], [w, h - d], [w - d, h - d], [w - d, h], [d, h], [d, h - d], [0, h - d], [0, d], [d, d]]) }
    }
    case 'star4':
    case 'star5':
    case 'star6':
    case 'star8':
    case 'star10':
    case 'star12': {
      const n = +prst.slice(4)
      const inner = prst === 'star5' ? 0.382 : prst === 'star4' ? 0.25 : 0.5
      const pts: Array<[number, number]> = []
      for (let i = 0; i < n * 2; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / n
        const r = i % 2 ? inner : 1
        pts.push([w / 2 + (Math.cos(ang) * r * w) / 2, h / 2 + (Math.sin(ang) * r * h) / 2])
      }
      return { cmds: poly(pts) }
    }
    case 'line':
    case 'straightConnector1':
    case 'bentConnector2':
    case 'bentConnector3':
    case 'bentConnector4':
    case 'curvedConnector3':
      if (prst === 'bentConnector3') {
        const x = w * a('adj1', 50000)
        return { cmds: poly([[0, 0], [x, 0], [x, h], [w, h]], false), open: true }
      }
      return { cmds: poly([[0, 0], [w, h]], false), open: true }
    default:
      return null
  }
}

function roundCmds(w: number, h: number, [tl, tr, br, bl]: number[]): Cmd[] {
  const lim = Math.min(w, h) / 2
  ;[tl, tr, br, bl] = [tl, tr, br, bl].map((r) => Math.min(r, lim))
  const out: Cmd[] = [{ c: 'M', p: [tl, 0] }, { c: 'L', p: [w - tr, 0] }]
  if (tr) out.push({ c: 'A', rx: tr, ry: tr, rot: 0, large: 0, sweep: 1, p: [w, tr] })
  out.push({ c: 'L', p: [w, h - br] })
  if (br) out.push({ c: 'A', rx: br, ry: br, rot: 0, large: 0, sweep: 1, p: [w - br, h] })
  out.push({ c: 'L', p: [bl, h] })
  if (bl) out.push({ c: 'A', rx: bl, ry: bl, rot: 0, large: 0, sweep: 1, p: [0, h - bl] })
  out.push({ c: 'L', p: [0, tl] })
  if (tl) out.push({ c: 'A', rx: tl, ry: tl, rot: 0, large: 0, sweep: 1, p: [tl, 0] })
  out.push({ c: 'Z' })
  return out
}

/** Shape guides: DrawingML's little formula language for custom geometry. */
function guides(geom: Element, w: number, h: number): Map<string, number> {
  const W = w * EMU_PX
  const H = h * EMU_PX
  const g = new Map<string, number>(
    Object.entries({
      w: W, h: H, l: 0, t: 0, r: W, b: H, hc: W / 2, vc: H / 2,
      wd2: W / 2, hd2: H / 2, wd3: W / 3, hd3: H / 3, wd4: W / 4, hd4: H / 4, wd5: W / 5, hd5: H / 5,
      wd6: W / 6, hd6: H / 6, wd8: W / 8, hd8: H / 8, wd10: W / 10, hd10: H / 10, wd32: W / 32,
      ss: Math.min(W, H), ls: Math.max(W, H), ssd2: Math.min(W, H) / 2, ssd4: Math.min(W, H) / 4,
      ssd6: Math.min(W, H) / 6, ssd8: Math.min(W, H) / 8, ssd16: Math.min(W, H) / 16, ssd32: Math.min(W, H) / 32,
      cd2: 10800000, cd4: 5400000, cd8: 2700000, '3cd4': 16200000, '3cd8': 8100000, '5cd8': 13500000, '7cd8': 18900000,
    }),
  )
  const val = (t: string) => (g.has(t) ? g.get(t)! : parseFloat(t) || 0)
  const rad = (a: number) => (a / 60000) * (Math.PI / 180)
  const evalF = (f: string): number => {
    const [op, ...a] = f.trim().split(/\s+/)
    const [x, y, z] = a.map(val)
    switch (op) {
      case '*/': return (x * y) / (z || 1)
      case '+-': return x + y - z
      case '+/': return (x + y) / (z || 1)
      case '?:': return x > 0 ? y : z
      case 'abs': return Math.abs(x)
      case 'at2': return (Math.atan2(y, x) * 180 / Math.PI) * 60000
      case 'cat2': return x * Math.cos(Math.atan2(z, y))
      case 'sat2': return x * Math.sin(Math.atan2(z, y))
      case 'cos': return x * Math.cos(rad(y))
      case 'sin': return x * Math.sin(rad(y))
      case 'tan': return x * Math.tan(rad(y))
      case 'max': return Math.max(x, y)
      case 'min': return Math.min(x, y)
      case 'mod': return Math.sqrt(x * x + y * y + (z || 0) * (z || 0))
      case 'pin': return y < x ? x : y > z ? z : y
      case 'sqrt': return Math.sqrt(x)
      case 'val': return x
      default: return 0
    }
  }
  for (const list of [kid(geom, 'avLst'), kid(geom, 'gdLst')])
    for (const gd of kids(list, 'gd')) g.set(gd.getAttribute('name') ?? '', evalF(gd.getAttribute('fmla') ?? 'val 0'))
  return g
}

function customCmds(geom: Element, w: number, h: number): Cmd[] {
  const out: Cmd[] = []
  const gv = guides(geom, w, h)
  const num = (v: string | null) => (v == null ? 0 : gv.has(v) ? gv.get(v)! : parseFloat(v) || 0)
  for (const path of kids(kid(geom, 'pathLst'), 'path')) {
    const pw = +(path.getAttribute('w') ?? 0) || w * EMU_PX
    const ph = +(path.getAttribute('h') ?? 0) || h * EMU_PX
    const sx = w / pw
    const sy = h / ph
    const pt = (el: Element | null): [number, number] => [num(el?.getAttribute('x') ?? null) * sx, num(el?.getAttribute('y') ?? null) * sy]
    let cur: [number, number] = [0, 0]
    for (const c of path.children) {
      const pts = kids(c, 'pt')
      switch (c.localName) {
        case 'moveTo':
          cur = pt(pts[0])
          out.push({ c: 'M', p: cur })
          break
        case 'lnTo':
          cur = pt(pts[0])
          out.push({ c: 'L', p: cur })
          break
        case 'cubicBezTo':
          cur = pt(pts[2])
          out.push({ c: 'C', p1: pt(pts[0]), p2: pt(pts[1]), p: cur })
          break
        case 'quadBezTo':
          cur = pt(pts[1])
          out.push({ c: 'Q', p1: pt(pts[0]), p: cur })
          break
        case 'arcTo': {
          const rx = num(c.getAttribute('wR')) * sx
          const ry = num(c.getAttribute('hR')) * sy
          const st = ((num(c.getAttribute('stAng')) / 60000) * Math.PI) / 180
          const sw = ((num(c.getAttribute('swAng')) / 60000) * Math.PI) / 180
          const cx = cur[0] - rx * Math.cos(st)
          const cy = cur[1] - ry * Math.sin(st)
          const end: [number, number] = [cx + rx * Math.cos(st + sw), cy + ry * Math.sin(st + sw)]
          if (Math.abs(sw) >= Math.PI * 2 - 1e-6) {
            const mid: [number, number] = [cx - rx * Math.cos(st), cy - ry * Math.sin(st)]
            out.push({ c: 'A', rx, ry, rot: 0, large: 0, sweep: sw > 0 ? 1 : 0, p: mid })
          }
          out.push({ c: 'A', rx, ry, rot: 0, large: Math.abs(sw) > Math.PI ? 1 : 0, sweep: sw > 0 ? 1 : 0, p: end })
          cur = end
          break
        }
        case 'close':
          out.push({ c: 'Z' })
          break
      }
    }
  }
  return out
}

function transformCmds(cmds: Cmd[], m: [number, number, number, number, number, number], rotDeg: number, flip: boolean): Cmd[] {
  const T = ([x, y]: [number, number]): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  return cmds.map((c) => {
    switch (c.c) {
      case 'M':
      case 'L':
        return { c: c.c, p: T(c.p) }
      case 'C':
        return { c: 'C', p1: T(c.p1), p2: T(c.p2), p: T(c.p) }
      case 'Q':
        return { c: 'Q', p1: T(c.p1), p: T(c.p) }
      case 'A':
        return { ...c, rot: c.rot + rotDeg, sweep: flip ? 1 - c.sweep : c.sweep, p: T(c.p) }
      default:
        return c
    }
  })
}
const n2 = (v: number) => +v.toFixed(2)
function svgPath(cmds: Cmd[]): string {
  return cmds
    .map((c) => {
      switch (c.c) {
        case 'M':
        case 'L':
          return `${c.c}${n2(c.p[0])} ${n2(c.p[1])}`
        case 'C':
          return `C${n2(c.p1[0])} ${n2(c.p1[1])} ${n2(c.p2[0])} ${n2(c.p2[1])} ${n2(c.p[0])} ${n2(c.p[1])}`
        case 'Q':
          return `Q${n2(c.p1[0])} ${n2(c.p1[1])} ${n2(c.p[0])} ${n2(c.p[1])}`
        case 'A':
          return `A${n2(c.rx)} ${n2(c.ry)} ${n2(c.rot)} ${c.large} ${c.sweep} ${n2(c.p[0])} ${n2(c.p[1])}`
        default:
          return 'Z'
      }
    })
    .join('')
}

// ---------- text styles ----------

interface RunStyle {
  size?: number // pt
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  caps?: boolean
  spacing?: number // pt
  baseline?: number
  color?: Color
  font?: string
}
interface ParaStyle {
  algn?: string
  marL?: number
  indent?: number
  lnSpcPct?: number
  lnSpcPts?: number
  spcBefPct?: number
  spcBefPts?: number
  spcAftPct?: number
  spcAftPts?: number
  bullet?: { kind: 'none' } | { kind: 'char'; char: string } | { kind: 'num'; type: string; start: number }
  buFont?: string
  buColor?: Color
  buSize?: number
  run: RunStyle
}

function readRun(rPr: Element | null, ctx: Ctx, into: RunStyle) {
  if (!rPr) return
  const at = (n: string) => rPr.getAttribute(n)
  if (at('sz')) into.size = +at('sz')! / 100
  if (at('b') !== null) into.bold = at('b') === '1' || at('b') === 'true'
  if (at('i') !== null) into.italic = at('i') === '1' || at('i') === 'true'
  if (at('u') !== null) into.underline = at('u') !== 'none'
  if (at('strike') !== null) into.strike = at('strike') !== 'noStrike'
  if (at('cap') !== null) into.caps = at('cap') === 'all' || at('cap') === 'small'
  if (at('spc') !== null) into.spacing = +at('spc')! / 100
  if (at('baseline') !== null) into.baseline = +at('baseline')! / 1000
  const fill = kid(rPr, 'solidFill')
  if (fill) {
    const c = colorIn(fill, ctx)
    if (c) into.color = c
  } else if (kid(rPr, 'gradFill')) {
    const stops = kids(kid(kid(rPr, 'gradFill'), 'gsLst'), 'gs').map((g) => colorIn(g, ctx)).filter((c): c is Color => !!c)
    if (stops.length) into.color = avg(stops.map((color) => ({ color })))
  }
  const latin = kid(rPr, 'latin')?.getAttribute('typeface')
  if (latin) into.font = latin
}

function readPara(pPr: Element | null, ctx: Ctx, into: ParaStyle) {
  if (!pPr) return
  const at = (n: string) => pPr.getAttribute(n)
  if (at('algn')) into.algn = at('algn')!
  if (at('marL') !== null) into.marL = px(at('marL'))
  if (at('indent') !== null) into.indent = px(at('indent'))
  const sp = (name: string): [number | undefined, number | undefined] => {
    const el = kid(pPr, name)
    if (!el) return [undefined, undefined]
    const pct = kid(el, 'spcPct')?.getAttribute('val')
    const pts = kid(el, 'spcPts')?.getAttribute('val')
    return [pct != null ? +pct / 100000 : undefined, pts != null ? +pts / 100 : undefined]
  }
  const [lp, lt] = sp('lnSpc')
  if (lp !== undefined || lt !== undefined) {
    into.lnSpcPct = lp
    into.lnSpcPts = lt
  }
  const [bp, bt] = sp('spcBef')
  if (bp !== undefined || bt !== undefined) {
    into.spcBefPct = bp
    into.spcBefPts = bt
  }
  const [ap, at2] = sp('spcAft')
  if (ap !== undefined || at2 !== undefined) {
    into.spcAftPct = ap
    into.spcAftPts = at2
  }
  if (kid(pPr, 'buNone')) into.bullet = { kind: 'none' }
  const bc = kid(pPr, 'buChar')
  if (bc) into.bullet = { kind: 'char', char: bc.getAttribute('char') ?? '•' }
  const bn = kid(pPr, 'buAutoNum')
  if (bn) into.bullet = { kind: 'num', type: bn.getAttribute('type') ?? 'arabicPeriod', start: +(bn.getAttribute('startAt') ?? 1) }
  const bf = kid(pPr, 'buFont')?.getAttribute('typeface')
  if (bf) into.buFont = bf
  const bcl = kid(pPr, 'buClr')
  if (bcl) {
    const c = colorIn(bcl, ctx)
    if (c) into.buColor = c
  }
  const bs = kid(pPr, 'buSzPct')?.getAttribute('val')
  if (bs) into.buSize = +bs / 100000
  readRun(kid(pPr, 'defRPr'), ctx, into.run)
}

/** List-style element (lstStyle / titleStyle / bodyStyle…) → its level props. */
function levelOf(list: Element | null | undefined, lvl: number): Element | null {
  return list ? kid(list, `lvl${lvl + 1}pPr`) : null
}

interface Source {
  list: Element | null
  ctx: Ctx
}

function resolveStyle(sources: Source[], lvl: number): ParaStyle {
  const st: ParaStyle = { run: {} }
  for (const s of sources) readPara(levelOf(s.list, lvl), s.ctx, st)
  return st
}

// ---------- shapes ----------

interface Box {
  x: number
  y: number
  w: number
  h: number
}
type Place = (b: Box) => Box

interface PhInfo {
  type: string
  idx: string | null
}

function phOf(sp: Element): PhInfo | null {
  const nv = sp.firstElementChild
  const nvPr = nv ? kid(nv, 'nvPr') : null
  const ph = nvPr ? kid(nvPr, 'ph') : null
  if (!ph) return null
  return { type: ph.getAttribute('type') ?? 'obj', idx: ph.getAttribute('idx') }
}

function findPh(p: Part | null, ph: PhInfo, master: boolean): Element | null {
  if (!p) return null
  const tree = all(p.doc, 'spTree')[0]
  if (!tree) return null
  const cands = [...all(tree, 'sp'), ...all(tree, 'pic')].filter((e) => phOf(e))
  const norm = (t: string) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' || t === 'obj' ? 'body' : t)
  if (!master && ph.idx !== null) {
    const byIdx = cands.find((e) => phOf(e)!.idx === ph.idx)
    if (byIdx) return byIdx
  }
  const exact = cands.find((e) => phOf(e)!.type === ph.type)
  if (exact) return exact
  return cands.find((e) => norm(phOf(e)!.type) === norm(ph.type)) ?? null
}

function xfrmOf(el: Element | null): (Box & { rot: number; flipH: boolean; flipV: boolean }) | null {
  if (!el) return null
  const spPr = kid(el, 'spPr') ?? kid(el, 'grpSpPr')
  const x = kid(spPr, 'xfrm') ?? kid(el, 'xfrm')
  const off = kid(x, 'off')
  const ext = kid(x, 'ext')
  if (!off || !ext) return null
  return {
    x: px(off.getAttribute('x')),
    y: px(off.getAttribute('y')),
    w: px(ext.getAttribute('cx')),
    h: px(ext.getAttribute('cy')),
    rot: +(x!.getAttribute('rot') ?? 0) / 60000,
    flipH: x!.getAttribute('flipH') === '1',
    flipV: x!.getAttribute('flipV') === '1',
  }
}

interface Layers {
  slide: Part
  layout: Part | null
  master: Part | null
  slideCtx: Ctx
  masterCtx: Ctx
  presDefault: Element | null
}

interface ShapeEnv {
  part: Part
  ctx: Ctx
  layers: Layers
  /** this part's role, for inheritance */
  role: 'slide' | 'layout' | 'master'
  place: Place
  out: HTMLElement
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderTree(tree: Element, env: ShapeEnv) {
  for (const el of tree.children) renderShape(el, env)
}

function renderShape(el: Element, env: ShapeEnv) {
  const name = el.localName
  if (name === 'AlternateContent') {
    const fb = kid(el, 'Fallback') ?? kid(el, 'Choice')
    if (fb) for (const c of fb.children) renderShape(c, env)
    return
  }
  const cNvPr = el.firstElementChild ? kid(el.firstElementChild, 'cNvPr') : null
  if (cNvPr?.getAttribute('hidden') === '1' || cNvPr?.getAttribute('hidden') === 'true') return
  if (name === 'grpSp') {
    const x = xfrmOf(el)
    const g = kid(kid(el, 'grpSpPr'), 'xfrm')
    const chOff = kid(g, 'chOff')
    const chExt = kid(g, 'chExt')
    let place = env.place
    if (x && chOff && chExt) {
      const cx = px(chOff.getAttribute('x'))
      const cy = px(chOff.getAttribute('y'))
      const cw = px(chExt.getAttribute('cx')) || 1
      const ch = px(chExt.getAttribute('cy')) || 1
      const sx = x.w / cw
      const sy = x.h / ch
      const outer = env.place
      place = (b) => outer({ x: x.x + (b.x - cx) * sx, y: x.y + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy })
    }
    for (const c of el.children) if (c.localName !== 'nvGrpSpPr' && c.localName !== 'grpSpPr') renderShape(c, { ...env, place })
    return
  }
  if (name === 'sp' || name === 'cxnSp') return renderSp(el, env)
  if (name === 'pic') return renderPic(el, env)
  if (name === 'graphicFrame') return renderFrame(el, env)
  if (name === 'contentPart') return
}

function inheritedSources(el: Element, env: ShapeEnv): { ph: PhInfo | null; chain: Element[] } {
  const ph = phOf(el)
  const chain: Element[] = []
  if (ph && env.role === 'slide') {
    const l = findPh(env.layers.layout, ph, false)
    const m = findPh(env.layers.master, l ? phOf(l) ?? ph : ph, true)
    if (m) chain.push(m)
    if (l) chain.push(l)
  } else if (ph && env.role === 'layout') {
    const m = findPh(env.layers.master, ph, true)
    if (m) chain.push(m)
  }
  chain.push(el)
  return { ph, chain }
}

function renderSp(el: Element, env: ShapeEnv) {
  const { ctx } = env
  const { ph, chain } = inheritedSources(el, env)
  // Placeholders on layouts and masters only define defaults.
  if (ph && env.role !== 'slide') return
  let xf = null
  for (const c of chain) xf = xfrmOf(c) ?? xf
  if (!xf) return
  const box = env.place(xf)
  const spPr = kid(el, 'spPr')
  const style = kid(el, 'style')

  // Fill and outline (own, else inherited placeholder, else style reference).
  let fill: Fill | null = null
  for (const c of chain) fill = fillOf(kid(c, 'spPr'), c === el ? ctx : env.layers.masterCtx, env.part) ?? fill
  if (!fill && style) {
    const ref = kid(style, 'fillRef')
    const idx = +(ref?.getAttribute('idx') ?? 0)
    const c = colorIn(ref, ctx)
    if (idx > 0 && c) fill = { kind: 'solid', color: c }
  }
  let line: { color: Color; w: number; dash?: string; head?: string; tail?: string } | null = null
  let lnEl: Element | null = null
  for (const c of chain) lnEl = kid(kid(c, 'spPr'), 'ln') ?? lnEl
  const styleLn = style ? kid(style, 'lnRef') : null
  const lnIdx = +(styleLn?.getAttribute('idx') ?? 0)
  const lnFill = lnEl ? fillOf(lnEl, ctx, env.part) : null
  let lnColor: Color | null = lnFill?.kind === 'solid' ? lnFill.color : lnFill?.kind === 'grad' ? avg(lnFill.stops) : null
  if (!lnFill && lnIdx > 0) lnColor = colorIn(styleLn, ctx)
  if (lnColor && lnFill?.kind !== 'none') {
    const wAttr = lnEl?.getAttribute('w')
    const w = wAttr ? px(wAttr) : lnIdx > 0 ? px(String(ctx.theme.lnWidths[lnIdx - 1] ?? 12700)) : 1
    line = {
      color: lnColor,
      w: Math.max(w, 0.5),
      dash: kid(lnEl, 'prstDash')?.getAttribute('val') ?? undefined,
      head: kid(lnEl, 'headEnd')?.getAttribute('type') ?? undefined,
      tail: kid(lnEl, 'tailEnd')?.getAttribute('type') ?? undefined,
    }
  }

  // Geometry.
  const geomEl = kid(spPr, 'prstGeom') ?? kid(spPr, 'custGeom')
  let shape: { cmds: Cmd[]; open?: boolean } | null = null
  if (geomEl?.localName === 'custGeom') shape = { cmds: customCmds(geomEl, box.w, box.h) }
  else if (geomEl) shape = presetCmds(geomEl.getAttribute('prst') ?? 'rect', box.w, box.h, adjOf(geomEl))
  else if (el.localName === 'cxnSp') shape = presetCmds('line', box.w, box.h, new Map())
  if (!shape && (fill || line)) shape = presetCmds('rect', box.w, box.h, new Map())

  const visibleFill = fill && fill.kind !== 'none'
  if (shape && (visibleFill || line)) {
    // Bake rotation and flips into the outline (dom-to-pdf keeps it vector).
    const cx = box.w / 2
    const cy = box.h / 2
    const r = (xf.rot * Math.PI) / 180
    const fx = xf.flipH ? -1 : 1
    const fy = xf.flipV ? -1 : 1
    const cos = Math.cos(r)
    const sin = Math.sin(r)
    const m: [number, number, number, number, number, number] = [
      cos * fx, sin * fx, -sin * fy, cos * fy,
      box.x + cx - (cos * fx * cx - sin * fy * cy),
      box.y + cy - (sin * fx * cx + cos * fy * cy),
    ]
    const cmds = transformCmds(shape.cmds, m, xf.rot, xf.flipH !== xf.flipV)
    const d = svgPath(cmds)
    if (/NaN|Infinity/.test(d)) return
    let fillAttr = 'none'
    if (visibleFill && !shape.open) {
      if (fill!.kind === 'solid') fillAttr = cssColor(fill!.color)
      else if (fill!.kind === 'grad') {
        // A gradient becomes a picture clipped to the shape's box when the
        // shape is a plain rectangle; other outlines use its average colour.
        const prst = geomEl?.getAttribute('prst')
        if ((prst === 'rect' || !geomEl) && !xf.rot) {
          const img = document.createElement('img')
          img.src = gradientImage(fill as Extract<Fill, { kind: 'grad' }>, box.w, box.h)
          img.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`
          env.out.appendChild(img)
        } else fillAttr = cssColor(avg((fill as Extract<Fill, { kind: 'grad' }>).stops))
      } else if (fill!.kind === 'image') {
        const img = document.createElement('img')
        img.src = fill!.src
        img.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`
        env.out.appendChild(img)
      }
    }
    const dash =
      line?.dash && line.dash !== 'solid'
        ? /dot/i.test(line.dash) && !/dash/i.test(line.dash)
          ? `${line.w} ${line.w * 2}`
          : `${line.w * 4} ${line.w * 3}`
        : ''
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:0;top:0;width:${env.out.style.width};height:${env.out.style.height};overflow:visible" viewBox="0 0 ${parseFloat(env.out.style.width)} ${parseFloat(env.out.style.height)}">`
    svg += `<path d="${d}" fill="${fillAttr}"${line ? ` stroke="${cssColor(line.color)}" stroke-width="${n2(line.w)}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"` : ' stroke="none"'}/>`
    // Arrowheads on lines.
    if (line && shape.open && (line.head && line.head !== 'none' || line.tail && line.tail !== 'none')) {
      const pts = cmds.filter((c): c is Extract<Cmd, { c: 'M' | 'L' }> => c.c === 'M' || c.c === 'L').map((c) => c.p)
      const arrow = (tip: [number, number], from: [number, number]) => {
        const a = Math.atan2(tip[1] - from[1], tip[0] - from[0])
        const L = Math.max(6, line!.w * 3.5)
        const W = L * 0.55
        const b: [number, number] = [tip[0] - Math.cos(a) * L, tip[1] - Math.sin(a) * L]
        const p1 = [b[0] + Math.sin(a) * W, b[1] - Math.cos(a) * W]
        const p2 = [b[0] - Math.sin(a) * W, b[1] + Math.cos(a) * W]
        return `<path d="M${n2(tip[0])} ${n2(tip[1])}L${n2(p1[0])} ${n2(p1[1])}L${n2(p2[0])} ${n2(p2[1])}Z" fill="${cssColor(line!.color)}"/>`
      }
      if (pts.length >= 2) {
        if (line.tail && line.tail !== 'none') svg += arrow(pts[pts.length - 1], pts[pts.length - 2])
        if (line.head && line.head !== 'none') svg += arrow(pts[0], pts[1])
      }
    }
    svg += '</svg>'
    env.out.insertAdjacentHTML('beforeend', svg)
  }

  // Text.
  const txBody = kid(el, 'txBody')
  if (txBody) renderText(txBody, chain, ph, box, xf, env, style)
}

function renderPic(el: Element, env: ShapeEnv) {
  const { chain, ph } = inheritedSources(el, env)
  if (ph && env.role !== 'slide') return
  let xf = null
  for (const c of chain) xf = xfrmOf(c) ?? xf
  if (!xf) return
  if (all(el, 'videoFile').length || all(el, 'audioFile').length || all(el, 'media').length) env.ctx.warnings.add('media')
  const blipFill = kid(el, 'blipFill')
  if (!blipFill) return
  const src = blipUrl(blipFill, env.ctx, env.part)
  if (!src) return
  const box = env.place(xf)
  const crop = kid(blipFill, 'srcRect')
  const l = +(crop?.getAttribute('l') ?? 0) / 100000
  const t = +(crop?.getAttribute('t') ?? 0) / 100000
  const r = +(crop?.getAttribute('r') ?? 0) / 100000
  const b = +(crop?.getAttribute('b') ?? 0) / 100000
  const wrap = document.createElement('div')
  const tr = [xf.rot ? `rotate(${xf.rot}deg)` : '', xf.flipH ? 'scaleX(-1)' : '', xf.flipV ? 'scaleY(-1)' : ''].filter(Boolean).join(' ')
  wrap.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;overflow:hidden${tr ? `;transform:${tr}` : ''}`
  const img = document.createElement('img')
  const iw = box.w / Math.max(0.01, 1 - l - r)
  const ih = box.h / Math.max(0.01, 1 - t - b)
  img.src = src
  img.style.cssText = `position:absolute;left:${-l * iw}px;top:${-t * ih}px;width:${iw}px;height:${ih}px;max-width:none`
  wrap.appendChild(img)
  env.out.appendChild(wrap)
  // Outline around a picture.
  const ln = kid(kid(el, 'spPr'), 'ln')
  const lf = ln ? fillOf(ln, env.ctx, env.part) : null
  if (lf?.kind === 'solid') {
    const w = px(ln!.getAttribute('w'), 1)
    wrap.style.outline = `${w}px solid ${cssColor(lf.color)}`
    const o = document.createElement('div')
    o.style.cssText = `position:absolute;left:${box.x - w / 2}px;top:${box.y - w / 2}px;width:${box.w}px;height:${box.h}px;border:${w}px solid ${cssColor(lf.color)}`
    env.out.appendChild(o)
  }
}

function renderFrame(el: Element, env: ShapeEnv) {
  const gd = all(el, 'graphicData')[0]
  const uri = gd?.getAttribute('uri') ?? ''
  const x = xfrmOf(el)
  if (!x) return
  const box = env.place(x)
  if (/chart/.test(uri)) {
    env.ctx.warnings.add('charts')
    return
  }
  if (/diagram/.test(uri)) return renderSmartArt(el, x, env)
  const tbl = kid(gd, 'tbl')
  if (tbl) return renderTable(tbl, box, env)
  // OLE objects carry a preview picture.
  const pic = all(el, 'pic')[0]
  if (pic) {
    const blip = kid(pic, 'blipFill')
    const src = blip ? blipUrl(blip, env.ctx, env.part) : null
    if (src) {
      const img = document.createElement('img')
      img.src = src
      img.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`
      env.out.appendChild(img)
    }
  }
}

function renderSmartArt(el: Element, box: Box, env: ShapeEnv) {
  // SmartArt keeps a pre-drawn copy of its shapes; draw that.
  const relIds = all(el, 'relIds')[0]
  const dm = rAttr(relIds, 'dm')
  const dataPath = dm ? env.part.rels.get(dm) : undefined
  const data = dataPath ? xml(env.ctx.files, dataPath) : null
  const ext = data ? all(data, 'dataModelExt')[0] : null
  const drawingId = ext?.getAttribute('relId')
  let drawingPath = drawingId ? env.part.rels.get(drawingId) : undefined
  if (!drawingPath) drawingPath = [...env.part.rels.values()].find((p) => /diagrams\/drawing\d*\.xml$/.test(p))
  const drawing = drawingPath ? part(env.ctx.files, drawingPath) : null
  const tree = drawing ? all(drawing.doc, 'spTree')[0] : null
  if (!tree || !drawing) {
    env.ctx.warnings.add('smartart')
    return
  }
  // Its coordinates are relative to the frame.
  const outer = env.place
  renderTree(tree, { ...env, part: drawing, role: 'master', place: (b) => outer({ ...b, x: b.x + box.x, y: b.y + box.y }) })
}

// ---------- tables ----------

const TABLE_ACCENTS: Record<string, string> = {
  '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}': 'accent1',
  '{21E4AEA4-8DFA-4A89-87EB-49C32662AFE8}': 'accent2',
  '{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}': 'accent3',
  '{00A15C55-8517-42AA-B614-E9B94910E393}': 'accent4',
  '{7DF18680-E054-41AD-8BC1-D1AEF772440D}': 'accent5',
  '{93296810-A885-4BE3-A3E7-6D5BEEA58F35}': 'accent6',
  '{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}': 'dk1',
}

interface CellLook {
  fill?: Color
  bold?: boolean
  color?: Color
  borders: Partial<Record<'left' | 'right' | 'top' | 'bottom', { w: number; color: Color } | null>>
}

function tableLook(styleId: string, ctx: Ctx): ((part: string) => CellLook | null) | null {
  const style = all(ctx.tableStyles, 'tblStyle').find((s) => s.getAttribute('styleId') === styleId)
  if (style) {
    return (name) => {
      const el = kid(style, name)
      if (!el) return null
      const look: CellLook = { borders: {} }
      const tcTx = kid(el, 'tcTxStyle')
      if (tcTx) {
        if (tcTx.getAttribute('b') === 'on') look.bold = true
        const c = colorOf([...tcTx.children].find((x) => /Clr$/.test(x.localName)) ?? null, ctx) ?? colorIn(kid(tcTx, 'fontRef'), ctx)
        if (c) look.color = c
      }
      const tcStyle = kid(el, 'tcStyle')
      const fill = fillOf(kid(tcStyle, 'fill'), ctx, { path: '', doc: document.implementation.createDocument(null, null), rels: new Map(), ext: new Map() })
      if (fill?.kind === 'solid') look.fill = fill.color
      else if (!fill) {
        const ref = kid(tcStyle, 'fillRef')
        const c = colorIn(ref, ctx)
        if (c) look.fill = c
      }
      const bdr = kid(tcStyle, 'tcBdr')
      for (const [side, names] of [['left', ['left']], ['right', ['right']], ['top', ['top', 'insideH']], ['bottom', ['bottom', 'insideH']]] as const) {
        for (const nm of names) {
          const s = kid(bdr, nm)
          if (!s) continue
          const ln = kid(s, 'ln')
          const lf = ln ? fillOf(ln, ctx, { path: '', doc: document.implementation.createDocument(null, null), rels: new Map(), ext: new Map() }) : null
          if (lf?.kind === 'solid') look.borders[side] = { w: px(ln!.getAttribute('w'), 1), color: lf.color }
          else if (lf?.kind === 'none') look.borders[side] = null
          break
        }
      }
      return look
    }
  }
  const accent = TABLE_ACCENTS[styleId] ?? (styleId ? 'accent1' : null)
  if (!accent) return null
  // Built-in "Medium Style 2" (PowerPoint's default table look).
  const base = ctx.theme.colors[accent] ?? '4472C4'
  const c = (tint: number): Color => {
    const r = parseInt(base.slice(0, 2), 16) / 255
    const g = parseInt(base.slice(2, 4), 16) / 255
    const b = parseInt(base.slice(4, 6), 16) / 255
    return { r: r * tint + (1 - tint), g: g * tint + (1 - tint), b: b * tint + (1 - tint), a: 1 }
  }
  const white: Color = { r: 1, g: 1, b: 1, a: 1 }
  const bd = { w: 1.33, color: white }
  return (name) => {
    switch (name) {
      case 'wholeTbl':
        return { fill: c(0.2), borders: { left: bd, right: bd, top: bd, bottom: bd } }
      case 'band1H':
      case 'band1V':
        return { fill: c(0.4), borders: {} }
      case 'firstRow':
      case 'lastRow':
      case 'firstCol':
      case 'lastCol':
        return { fill: c(1), bold: true, color: white, borders: name === 'firstRow' ? { bottom: { w: 4, color: white } } : {} }
      default:
        return null
    }
  }
}

function renderTable(tbl: Element, box: Box, env: ShapeEnv) {
  const { ctx } = env
  const pr = kid(tbl, 'tblPr')
  const flag = (n: string) => pr?.getAttribute(n) === '1' || pr?.getAttribute(n) === 'true'
  const styleId = kid(pr, 'tableStyleId')?.textContent?.trim() ?? ''
  const look = tableLook(styleId, ctx)
  const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => px(g.getAttribute('w')))
  const rows = kids(tbl, 'tr')
  const scale = box.w / (cols.reduce((a, b) => a + b, 0) || box.w)
  const table = document.createElement('table')
  table.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;border-collapse:collapse;table-layout:fixed`
  table.innerHTML = `<colgroup>${cols.map((w) => `<col style="width:${w * scale}px">`).join('')}</colgroup>`
  const tbody = document.createElement('tbody')
  table.appendChild(tbody)
  rows.forEach((tr, ri) => {
    const row = document.createElement('tr')
    row.style.height = `${px(tr.getAttribute('h'))}px`
    let ci = 0
    for (const tc of kids(tr, 'tc')) {
      const col = ci
      const span = +(tc.getAttribute('gridSpan') ?? 1)
      const rspan = +(tc.getAttribute('rowSpan') ?? 1)
      ci += 1
      if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') continue
      const parts = ['wholeTbl']
      const first = flag('firstRow') && ri === 0
      const last = flag('lastRow') && ri === rows.length - 1
      const bandIdx = ri - (flag('firstRow') ? 1 : 0)
      if (flag('bandRow') && !first && !last) parts.push(bandIdx % 2 === 0 ? 'band1H' : 'band2H')
      if (flag('bandCol')) parts.push(col % 2 === 0 ? 'band1V' : 'band2V')
      if (flag('firstCol') && col === 0) parts.push('firstCol')
      if (flag('lastCol') && col === cols.length - 1) parts.push('lastCol')
      if (last) parts.push('lastRow')
      if (first) parts.push('firstRow')
      const merged: CellLook = { borders: {} }
      for (const p of parts) {
        const l = look?.(p)
        if (!l) continue
        if (l.fill) merged.fill = l.fill
        if (l.bold !== undefined) merged.bold = l.bold
        if (l.color) merged.color = l.color
        Object.assign(merged.borders, l.borders)
      }
      const tcPr = kid(tc, 'tcPr')
      const own = fillOf(tcPr, ctx, env.part)
      if (own?.kind === 'solid') merged.fill = own.color
      else if (own?.kind === 'none') merged.fill = undefined
      for (const [side, nm] of [['left', 'lnL'], ['right', 'lnR'], ['top', 'lnT'], ['bottom', 'lnB']] as const) {
        const ln = kid(tcPr, nm)
        if (!ln) continue
        const lf = fillOf(ln, ctx, env.part)
        if (lf?.kind === 'solid') merged.borders[side] = { w: px(ln.getAttribute('w'), 1), color: lf.color }
        else if (lf?.kind === 'none') merged.borders[side] = null
      }
      const td = document.createElement('td')
      if (span > 1) td.colSpan = span
      if (rspan > 1) td.rowSpan = rspan
      const ins = (n: string, d: number) => px(tcPr?.getAttribute(n), d)
      const anchor = tcPr?.getAttribute('anchor') ?? 't'
      td.style.cssText =
        `padding:${ins('marT', 4.8)}px ${ins('marR', 9.6)}px ${ins('marB', 4.8)}px ${ins('marL', 9.6)}px;` +
        `vertical-align:${anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top'};` +
        (merged.fill ? `background:${cssColor(merged.fill)};` : '') +
        (['left', 'right', 'top', 'bottom'] as const)
          .map((s) => {
            const b = merged.borders[s]
            return b ? `border-${s}:${Math.max(0.75, b.w)}px solid ${cssColor(b.color)};` : ''
          })
          .join('')
      const body = kid(tc, 'txBody')
      if (body) {
        const runDefaults: RunStyle = { size: 18 }
        if (merged.bold) runDefaults.bold = true
        if (merged.color) runDefaults.color = merged.color
        td.innerHTML = paragraphsHtml(body, [], env, runDefaults, 1, 0, 'otherStyle')
      }
      row.appendChild(td)
    }
    tbody.appendChild(row)
  })
  env.out.appendChild(table)
}

// ---------- text ----------

function numText(type: string, n: number): string {
  const m = /^(arabic|alphaLc|alphaUc|romanLc|romanUc)(Period|ParenR|ParenBoth|Plain|Minus)?/.exec(type)
  const kind = m?.[1] ?? 'arabic'
  const style = kind === 'alphaLc' ? 'lower-alpha' : kind === 'alphaUc' ? 'upper-alpha' : kind === 'romanLc' ? 'lower-roman' : kind === 'romanUc' ? 'upper-roman' : 'decimal'
  const t = counterText(n, style)
  switch (m?.[2]) {
    case 'ParenR':
      return `${t})`
    case 'ParenBoth':
      return `(${t})`
    case 'Plain':
      return t
    case 'Minus':
      return `- ${t}`
    default:
      return `${t}.`
  }
}

function fontFor(name: string | undefined, ctx: Ctx, title: boolean): string {
  let f = name ?? (title ? '+mj-lt' : '+mn-lt')
  if (f === '+mj-lt' || f === '+mj-ea' || f === '+mj-cs') f = ctx.theme.major
  if (f === '+mn-lt' || f === '+mn-ea' || f === '+mn-cs') f = ctx.theme.minor
  return f
}

function runCss(r: RunStyle, ctx: Ctx, scale: number, title: boolean): string {
  const size = (r.size ?? 18) * scale * (r.baseline ? 0.66 : 1)
  const parts = [
    `font-family:${cssStack(mapFamily(fontFor(r.font, ctx, title)))}`,
    `font-size:${+((size * 4) / 3).toFixed(2)}px`,
    `font-weight:${r.bold ? 700 : 400}`,
    `font-style:${r.italic ? 'italic' : 'normal'}`,
    `color:${cssColor(r.color ?? colorOf(document.createElementNS('x', 'schemeClr'), ctx) ?? { r: 0, g: 0, b: 0, a: 1 })}`,
  ]
  const dec = [r.underline ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  if (dec) parts.push(`text-decoration:${dec}`)
  if (r.spacing) parts.push(`letter-spacing:${+((r.spacing * 4) / 3).toFixed(2)}px`)
  if (r.baseline) parts.push(`position:relative;top:${r.baseline > 0 ? -size * 0.45 : size * 0.15}px`)
  return parts.join(';')
}

/** Paragraphs of a text body as HTML, with inherited list styles. */
function paragraphsHtml(
  txBody: Element,
  lists: Source[],
  env: ShapeEnv,
  runDefaults: RunStyle,
  fontScale: number,
  lnReduce: number,
  kind: 'titleStyle' | 'bodyStyle' | 'otherStyle',
): string {
  const { ctx } = env
  const own: Source = { list: kid(txBody, 'lstStyle'), ctx }
  const counters: number[] = []
  let prevLvl = -1
  let prevNum = false
  const html: string[] = []
  const title = kind === 'titleStyle'
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr')
    const lvl = +(pPr?.getAttribute('lvl') ?? 0)
    // Inherited list styles, then the shape's style reference (e.g. white
    // text on a filled shape), then the shape's own list style and paragraph.
    const st = resolveStyle(lists, lvl)
    st.run = { ...st.run, ...runDefaults }
    readPara(levelOf(own.list, lvl), ctx, st)
    readPara(pPr, ctx, st)
    const runs = [...p.children].filter((c) => c.localName === 'r' || c.localName === 'br' || c.localName === 'fld')
    const endPr = kid(p, 'endParaRPr')
    const firstRun: RunStyle = { ...st.run }
    const fr = runs.find((r) => r.localName !== 'br')
    readRun(fr ? kid(fr, 'rPr') : endPr, ctx, firstRun)
    const size = (firstRun.size ?? 18) * fontScale
    const lineH =
      st.lnSpcPts !== undefined
        ? `${(st.lnSpcPts * 4) / 3}px`
        : String(+(1.2 * Math.max(0.1, (st.lnSpcPct ?? 1) - lnReduce)).toFixed(3))
    const spc = (pct: number | undefined, pts: number | undefined) =>
      pts !== undefined ? (pts * 4) / 3 : pct !== undefined ? pct * size * 1.2 * (4 / 3) : 0
    const algn = st.algn ?? 'l'
    const align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' || algn === 'dist' ? 'justify' : 'left'
    const marL = st.marL ?? 0
    const indent = st.indent ?? 0
    const style = [
      `margin:${spc(st.spcBefPct, st.spcBefPts)}px 0 ${spc(st.spcAftPct, st.spcAftPts)}px ${marL}px`,
      `text-indent:${indent}px`,
      `text-align:${align}`,
      `line-height:${lineH}`,
      `font-size:${+((size * 4) / 3).toFixed(2)}px`,
    ].join(';')

    // Bullet.
    let bullet = ''
    const hasText = runs.some((r) => (r.textContent ?? '').length > 0)
    if (lvl < prevLvl) counters.length = lvl + 1
    if (st.bullet && st.bullet.kind !== 'none' && hasText) {
      let text: string
      if (st.bullet.kind === 'char') text = mapSymbolText(st.bullet.char, st.buFont ?? '')
      else {
        const n = prevNum && prevLvl >= lvl && counters[lvl] !== undefined ? counters[lvl] + 1 : st.bullet.start
        counters[lvl] = n
        text = numText(st.bullet.type, n)
      }
      const bStyle: RunStyle = { ...firstRun, underline: false, strike: false, spacing: 0 }
      if (st.buColor) bStyle.color = st.buColor
      if (st.buSize) bStyle.size = (firstRun.size ?? 18) * st.buSize
      if (st.buFont && st.bullet.kind === 'char' && !/symbol|wingdings/i.test(st.buFont)) bStyle.font = st.buFont
      else if (st.bullet.kind === 'char') bStyle.font = undefined
      const width = indent < 0 ? -indent : 0
      bullet = `<span style="${runCss(bStyle, ctx, fontScale, title)};display:inline-block;text-indent:0;min-width:${width}px;white-space:pre">${esc(text)}${width ? '' : ' '}</span>`
    }
    prevNum = st.bullet?.kind === 'num' && hasText
    prevLvl = lvl

    const parts: string[] = []
    for (const r of runs) {
      if (r.localName === 'br') {
        parts.push('<br>')
        continue
      }
      const rs: RunStyle = { ...st.run }
      readRun(kid(r, 'rPr'), ctx, rs)
      let text = kid(r, 't')?.textContent ?? ''
      if (r.localName === 'fld' && /slidenum/i.test(r.getAttribute('type') ?? '')) text = String(ctx.slideNo)
      if (rs.caps) text = text.toUpperCase()
      if (rs.font && /symbol|wingdings/i.test(rs.font)) text = mapSymbolText(text, rs.font)
      let span = `<span style="${runCss(rs, ctx, fontScale, title)}">${esc(text)}</span>`
      const link = kid(kid(r, 'rPr'), 'hlinkClick')
      const href = link ? env.part.ext.get(rAttr(link, 'id') ?? '') : undefined
      if (href && /^(https?:|mailto:)/i.test(href)) span = `<a href="${esc(href)}" style="color:inherit;text-decoration:inherit">${span}</a>`
      parts.push(span)
    }
    if (!hasText) parts.push('<br>')
    html.push(`<div style="${style}">${bullet}${parts.join('')}</div>`)
  }
  return html.join('')
}

function renderText(txBody: Element, chain: Element[], ph: PhInfo | null, box: Box, xf: { rot: number; flipV: boolean }, env: ShapeEnv, style: Element | null) {
  const { ctx, layers } = env
  const paras = kids(txBody, 'p')
  if (!paras.some((p) => (p.textContent ?? '').trim())) return
  // Body properties: inherited, then own.
  const bp: Record<string, string> = {}
  let autofit: Element | null = null
  for (const c of chain) {
    const b = kid(kid(c, 'txBody'), 'bodyPr')
    if (!b) continue
    for (const a of b.attributes) bp[a.name] = a.value
    const af = kid(b, 'normAutofit') ?? kid(b, 'noAutofit') ?? kid(b, 'spAutoFit')
    if (af) autofit = af
  }
  const fontScale = autofit?.localName === 'normAutofit' ? +(autofit.getAttribute('fontScale') ?? 100000) / 100000 : 1
  const lnReduce = autofit?.localName === 'normAutofit' ? +(autofit.getAttribute('lnSpcReduction') ?? 0) / 100000 : 0

  const type = ph?.type
  const kind: 'titleStyle' | 'bodyStyle' | 'otherStyle' =
    type === 'title' || type === 'ctrTitle' ? 'titleStyle' : ph && !['dt', 'ftr', 'sldNum'].includes(type!) ? 'bodyStyle' : 'otherStyle'
  const masterTx = layers.master ? all(layers.master.doc, 'txStyles')[0] : null
  const lists: Source[] = []
  if (kind === 'otherStyle' && layers.presDefault) lists.push({ list: layers.presDefault, ctx: layers.masterCtx })
  if (masterTx) lists.push({ list: kid(masterTx, kind), ctx: layers.masterCtx })
  for (const c of chain) if (c !== chain[chain.length - 1]) lists.push({ list: kid(kid(c, 'txBody'), 'lstStyle'), ctx: layers.masterCtx })

  const runDefaults: RunStyle = {}
  const fontRef = style ? kid(style, 'fontRef') : null
  if (fontRef) {
    const c = colorIn(fontRef, ctx)
    if (c) runDefaults.color = c
    const idx = fontRef.getAttribute('idx')
    if (idx === 'major') runDefaults.font = '+mj-lt'
  }

  const lIns = px(bp.lIns, 9.6)
  const rIns = px(bp.rIns, 9.6)
  const tIns = px(bp.tIns, 4.8)
  const bIns = px(bp.bIns, 4.8)
  const anchor = bp.anchor ?? (kind === 'titleStyle' && type === 'ctrTitle' ? 'ctr' : 't')
  const wrap = bp.wrap !== 'none'
  const vert = bp.vert ?? 'horz'
  let rot = xf.rot + (xf.flipV ? 180 : 0) + (bp.rot ? +bp.rot / 60000 : 0)
  let w = box.w
  let h = box.h
  if (vert === 'vert' || vert === 'eaVert') rot += 90
  if (vert === 'vert270') rot += 270
  if (vert === 'vert' || vert === 'vert270' || vert === 'eaVert') [w, h] = [h, w]
  const div = document.createElement('div')
  div.style.cssText = [
    'position:absolute',
    `left:${box.x + (box.w - w) / 2}px`,
    `top:${box.y + (box.h - h) / 2}px`,
    `width:${w}px`,
    `height:${h}px`,
    'box-sizing:border-box',
    `padding:${tIns}px ${rIns}px ${bIns}px ${lIns}px`,
    'display:flex',
    'flex-direction:column',
    `justify-content:${anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start'}`,
    `white-space:${wrap ? 'pre-wrap' : 'pre'}`,
    'overflow-wrap:break-word',
    'overflow:visible',
    rot % 360 ? `transform:rotate(${rot}deg)` : '',
  ]
    .filter(Boolean)
    .join(';')
  const inner = document.createElement('div')
  if (!wrap) inner.style.cssText = anchor === 'ctr' || bp.anchorCtr === '1' ? 'align-self:center' : ''
  inner.innerHTML = paragraphsHtml(txBody, lists, env, runDefaults, fontScale, lnReduce, kind)
  div.appendChild(inner)
  env.out.appendChild(div)
}

// ---------- slides ----------

function background(layersList: Array<{ p: Part | null; ctx: Ctx }>, W: number, H: number): HTMLElement | null {
  for (const { p, ctx } of layersList) {
    const bg = p ? all(p.doc, 'bg')[0] : null
    if (!bg || !p) continue
    const bgPr = kid(bg, 'bgPr')
    let fill: Fill | null = null
    if (bgPr) fill = fillOf(bgPr, ctx, p)
    else {
      const ref = kid(bg, 'bgRef')
      const c = colorIn(ref, ctx)
      if (c) fill = { kind: 'solid', color: c }
    }
    if (!fill) continue
    if (fill.kind === 'none') return null
    if (fill.kind === 'solid') {
      const d = document.createElement('div')
      d.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:${cssColor(fill.color)}`
      return d
    }
    const img = document.createElement('img')
    img.src = fill.kind === 'image' ? fill.src : gradientImage(fill, W, H)
    img.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`
    return img
  }
  return null
}

function clrMapOf(master: Part | null): Record<string, string> {
  const map: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }
  const el = master ? all(master.doc, 'clrMap')[0] : null
  if (el) for (const a of el.attributes) map[a.name] = a.value
  return map
}

export async function pptxToPdf(
  data: ArrayBuffer,
  opts: { title?: string; onProgress?: (f: number) => void } = {},
): Promise<OfficeResult> {
  const files = unzipSync(new Uint8Array(data))
  const presPath = 'ppt/presentation.xml'
  const pres = xml(files, presPath)
  if (!pres) throw new Error('this is not a PowerPoint presentation')
  const presRels = rels(files, presPath)
  const sz = all(pres, 'sldSz')[0]
  const W = px(sz?.getAttribute('cx'), 960)
  const H = px(sz?.getAttribute('cy'), 540)
  const presDefault = all(pres, 'defaultTextStyle')[0] ?? null
  const tableStylesPath = [...presRels.values()].find((p) => /tableStyles\.xml$/.test(p))
  const tableStyles = tableStylesPath ? xml(files, tableStylesPath) : null
  const warnings = new Set<string>()
  const urls: string[] = []
  const host = makeHost()
  try {
    const sections: FlowSection[] = []
    const ids = all(all(pres, 'sldIdLst')[0] ?? null, 'sldId')
    for (const [i, sid] of ids.entries()) {
      const path = presRels.get(rAttr(sid, 'id') ?? '')
      const slide = path ? part(files, path) : null
      if (!slide) continue
      if (slide.doc.documentElement.getAttribute('show') === '0') continue
      const layoutPath = [...slide.rels.values()].find((p) => /slideLayouts\/slideLayout\d*\.xml$/.test(p))
      const layout = layoutPath ? part(files, layoutPath) : null
      const masterPath = layout ? [...layout.rels.values()].find((p) => /slideMasters\/slideMaster\d*\.xml$/.test(p)) : undefined
      const master = masterPath ? part(files, masterPath) : null
      const themePath = master ? [...master.rels.values()].find((p) => /theme\/theme\d*\.xml$/.test(p)) : undefined
      const theme = readTheme(themePath ? xml(files, themePath) : null)
      const clrMap = clrMapOf(master)
      const masterCtx: Ctx = { files, theme, clrMap, warnings, slideNo: i + 1, urls, tableStyles }
      const ovr = all(slide.doc, 'overrideClrMapping')[0]
      const slideMap = { ...clrMap }
      if (ovr) for (const a of ovr.attributes) slideMap[a.name] = a.value
      const slideCtx: Ctx = { ...masterCtx, clrMap: slideMap }
      const layers: Layers = { slide, layout, master, slideCtx, masterCtx, presDefault }

      const page = document.createElement('div')
      page.style.cssText = `position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#fff`
      host.appendChild(page)
      const bg = background(
        [
          { p: slide, ctx: slideCtx },
          { p: layout, ctx: masterCtx },
          { p: master, ctx: masterCtx },
        ],
        W,
        H,
      )
      if (bg) page.appendChild(bg)
      const identity: Place = (b) => b
      const showMaster = (p: Part | null) => (p ? p.doc.documentElement.getAttribute('showMasterSp') !== '0' : true)
      if (master && showMaster(slide) && showMaster(layout)) {
        const tree = all(master.doc, 'spTree')[0]
        if (tree) renderTree(tree, { part: master, ctx: masterCtx, layers, role: 'master', place: identity, out: page })
      }
      if (layout && showMaster(slide)) {
        const tree = all(layout.doc, 'spTree')[0]
        if (tree) renderTree(tree, { part: layout, ctx: masterCtx, layers, role: 'layout', place: identity, out: page })
      }
      const tree = all(slide.doc, 'spTree')[0]
      if (tree) renderTree(tree, { part: slide, ctx: slideCtx, layers, role: 'slide', place: identity, out: page })
      sections.push({ el: page, pageWidth: W, pageHeight: H, bodyTop: 0, bodyBottom: 0 })
      opts.onProgress?.(((i + 1) / ids.length) * 0.2)
    }
    if (!sections.length) throw new Error('this presentation has no visible slides')
    await settle(host)
    const bytes = await domToPdf(sections, {
      scale: 0.75,
      title: opts.title,
      onProgress: (f) => opts.onProgress?.(0.2 + f * 0.8),
    })
    return { bytes, warnings: [...warnings] }
  } finally {
    host.remove()
    for (const u of urls) URL.revokeObjectURL(u)
  }
}

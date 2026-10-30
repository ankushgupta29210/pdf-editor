/**
 * Turns pages laid out by the browser into a real PDF: text stays text (in
 * embedded, metric-matched fonts, so it is selectable and searchable), boxes,
 * borders and shapes stay vector, pictures are embedded as they are.
 *
 * The Office converters build ordinary HTML for each page (or for each
 * section, when content flows over several pages) and hand it here. Nothing
 * is screenshotted: every word is placed at the position the browser gave it.
 * Text in scripts no bundled font covers (Chinese, Arabic…) is drawn as a
 * small picture with an invisible text layer on top.
 */
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFPage,
  PDFRef,
  PDFString,
  clip as clipOp,
  concatTransformationMatrix,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setCharacterSpacing,
  type PDFFont,
  type PDFImage,
  type PDFOperatorNames,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { OfficeFontSet, isCovered, mapFamily, type FamilyKey } from './office-fonts'
import { addGlyphlessFont, utf16Hex } from './glyphless'
import { yieldToBrowser } from './limits'

type RGB = [number, number, number]
type Mat = [number, number, number, number, number, number]
interface Box {
  x: number
  y: number
  w: number
  h: number
}
type Group = 'body' | 'header' | 'footer'
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

interface Base {
  group: Group
  clip?: Box
  m?: Mat
  top: number
  bottom: number
  atomic: boolean
}
type Item = Base &
  (
    | { k: 'fill'; x: number; y: number; w: number; h: number; color: RGB; a: number; r: number }
    | { k: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; color: RGB; a: number; dash?: number[] }
    | {
        k: 'text'
        x: number
        base: number
        size: number
        text: string
        family: FamilyKey
        bold: boolean
        italic: boolean
        color: RGB
        a: number
        width: number
        spacing: number
        css: string
        h: number
      }
    | { k: 'raster'; x: number; y: number; w: number; h: number; png: Uint8Array; text: string; rtl: boolean }
    | { k: 'image'; x: number; y: number; w: number; h: number; src: string; a: number }
    | {
        k: 'path'
        x: number
        y: number
        scale: number
        d: string
        fill?: RGB
        fa: number
        stroke?: RGB
        sa: number
        sw: number
        dash?: number[]
      }
    | { k: 'link'; x: number; y: number; w: number; h: number; url: string }
  )

export interface FlowSection {
  /** The page box. Content may run taller than `pageHeight`; it is then split
   *  over several PDF pages between lines. */
  el: HTMLElement
  pageWidth: number
  pageHeight: number
  /** Body area on each page (px from the top / from the bottom). */
  bodyTop: number
  bodyBottom: number
  /** Repeated on every page this section produces. */
  header?: Element[]
  footer?: Element[]
  /** Elements that must not be split across pages (e.g. spreadsheet rows). */
  atomic?: Element[]
  /** Elements that should stay on the same page as what follows (headings). */
  keepWithNext?: Element[]
}

export interface DomToPdfOptions {
  /** PDF points per CSS pixel (0.75 = 96 dpi). */
  scale?: number
  title?: string
  onProgress?: (fraction: number) => void
}

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'])

function parseColor(v: string | null | undefined): { c: RGB; a: number } | null {
  if (!v) return null
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(v)
  if (!m) return null
  let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  if (!(a > 0)) a = 0
  return { c: [+m[1] / 255, +m[2] / 255, +m[3] / 255], a }
}

const mul = (A: Mat, B: Mat): Mat => [
  A[0] * B[0] + A[2] * B[1],
  A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3],
  A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4],
  A[1] * B[4] + A[3] * B[5] + A[5],
]
function inv(A: Mat): Mat {
  const det = A[0] * A[3] - A[1] * A[2]
  return [
    A[3] / det,
    -A[1] / det,
    -A[2] / det,
    A[0] / det,
    (A[2] * A[5] - A[3] * A[4]) / det,
    (A[1] * A[4] - A[0] * A[5]) / det,
  ]
}
function parseTransform(v: string): Mat | null {
  let m = /^matrix\(([^)]+)\)$/.exec(v)
  if (m) {
    const n = m[1].split(',').map(parseFloat)
    return [n[0], n[1], n[2], n[3], n[4], n[5]]
  }
  m = /^matrix3d\(([^)]+)\)$/.exec(v)
  if (m) {
    const n = m[1].split(',').map(parseFloat)
    return [n[0], n[1], n[4], n[5], n[12], n[13]]
  }
  return null
}
function intersect(a: Box | undefined, b: Box): Box {
  if (!a) return b
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) }
}

function roundRectPath(w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2)
  return `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('Could not encode an image')
  return new Uint8Array(await blob.arrayBuffer())
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image'))
    img.src = src
  })
}

interface Ctx {
  clip?: Box
  m?: Mat
  group: Group
  opacity: number
  decor?: { u: boolean; s: boolean; color: RGB }
  /** a clip set inside a transformed element can't be expressed; skip it */
  transformed: boolean
}

/** Collects the drawing items of one section, in section coordinates. */
class Collector {
  items: Item[] = []
  atomicBoxes: Array<[number, number]> = []
  keepBoxes: Array<[number, number]> = []
  private ox = 0
  private oy = 0
  private range = document.createRange()
  private baselines = new Map<string, number>()
  private probeHost: HTMLElement
  private groups = new Map<Element, Group>()
  private count = 0

  constructor(
    private section: FlowSection,
    private onElement: () => Promise<void>,
  ) {
    this.probeHost = section.el
    for (const e of section.header ?? []) this.groups.set(e, 'header')
    for (const e of section.footer ?? []) this.groups.set(e, 'footer')
  }

  async run() {
    const r = this.section.el.getBoundingClientRect()
    this.ox = r.left
    this.oy = r.top
    await this.walk(this.section.el, { group: 'body', opacity: 1, transformed: false })
    for (const e of this.section.atomic ?? []) {
      const b = e.getBoundingClientRect()
      if (b.height > 0) this.atomicBoxes.push([b.top - this.oy, b.bottom - this.oy])
    }
    for (const e of this.section.keepWithNext ?? []) {
      const b = e.getBoundingClientRect()
      if (b.height > 0) this.keepBoxes.push([b.top - this.oy, b.bottom - this.oy])
    }
  }

  private box(r: DOMRect | { left: number; top: number; width: number; height: number }): Box {
    return { x: r.left - this.ox, y: r.top - this.oy, w: r.width, h: r.height }
  }

  /** Where the baseline sits in a line box of this font, as a fraction of the
   *  box height — measured once per font, so it matches the browser exactly. */
  private baseline(cs: CSSStyleDeclaration): number {
    const key = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    let v = this.baselines.get(key)
    if (v !== undefined) return v
    const probe = document.createElement('div')
    probe.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;line-height:normal;font-style:${cs.fontStyle};font-weight:${cs.fontWeight};font-size:${cs.fontSize};font-family:${cs.fontFamily}`
    const text = document.createTextNode('Hxg')
    const mark = document.createElement('span')
    mark.style.cssText = 'display:inline-block;width:1px;height:0;vertical-align:baseline'
    probe.append(text, mark)
    this.probeHost.appendChild(probe)
    this.range.selectNodeContents(text)
    const tr = this.range.getBoundingClientRect()
    const mr = mark.getBoundingClientRect()
    v = tr.height > 0 ? (mr.bottom - tr.top) / tr.height : 0.8
    probe.remove()
    this.baselines.set(key, v)
    return v
  }

  private push(item: DistOmit<Item, 'group' | 'clip' | 'm' | 'top' | 'bottom' | 'atomic'>, ctx: Ctx, top: number, bottom: number, atomic: boolean) {
    this.items.push({ ...(item as Item), group: ctx.group, clip: ctx.clip, m: ctx.m, top, bottom, atomic })
  }

  private async walk(el: Element, parent: Ctx): Promise<void> {
    if (SKIP_TAGS.has(el.tagName)) return
    if (++this.count % 150 === 0) await this.onElement()
    const cs = getComputedStyle(el)
    if (cs.display === 'none') return
    const ctx: Ctx = { ...parent }
    const g = this.groups.get(el)
    if (g) ctx.group = g
    ctx.opacity *= parseFloat(cs.opacity || '1')
    if (ctx.opacity <= 0.001) return

    let restoreTransform: (() => void) | null = null
    if (cs.transform && cs.transform !== 'none') {
      const tm = parseTransform(cs.transform)
      if (tm && !(tm[0] === 1 && tm[1] === 0 && tm[2] === 0 && tm[3] === 1 && tm[4] === 0 && tm[5] === 0)) {
        const html = el as HTMLElement
        const saved = html.style.getPropertyValue('transform')
        const savedPrio = html.style.getPropertyPriority('transform')
        html.style.setProperty('transform', 'none', 'important')
        restoreTransform = () => html.style.setProperty('transform', saved, savedPrio)
        const r = el.getBoundingClientRect()
        const [tox, toy] = cs.transformOrigin.split(' ').map(parseFloat)
        const O: [number, number] = [r.left - this.ox + (tox || 0), r.top - this.oy + (toy || 0)]
        const local = mul(mul([1, 0, 0, 1, O[0], O[1]], tm), [1, 0, 0, 1, -O[0], -O[1]])
        ctx.m = ctx.m ? mul(ctx.m, local) : local
        ctx.transformed = true
      }
    }
    try {
      const visible = cs.visibility !== 'hidden' && cs.visibility !== 'collapse'
      // The page's own background goes under everything, on every page.
      if (visible) await this.paintBox(el, cs, el === this.section.el ? { ...ctx, group: 'header' } : ctx)

      if (el instanceof SVGSVGElement) {
        if (visible) await this.svg(el, ctx)
        return
      }
      if (el instanceof HTMLImageElement) {
        if (visible) this.image(el, ctx)
        return
      }
      if (el instanceof HTMLCanvasElement) {
        if (visible && el.width && el.height) {
          const b = this.box(el.getBoundingClientRect())
          try {
            this.push({ k: 'image', ...b, src: el.toDataURL('image/png'), a: ctx.opacity }, ctx, b.y, b.y + b.h, true)
          } catch {
            /* tainted canvas */
          }
        }
        return
      }

      const line = cs.textDecorationLine || ''
      if (/underline|line-through/.test(line)) {
        const dc = parseColor(cs.textDecorationColor) ?? parseColor(cs.color)
        ctx.decor = {
          u: line.includes('underline') || !!parent.decor?.u,
          s: line.includes('line-through') || !!parent.decor?.s,
          color: dc?.c ?? [0, 0, 0],
        }
      }

      if (el instanceof HTMLAnchorElement && /^(https?:|mailto:)/i.test(el.href)) {
        for (const r of el.getClientRects()) {
          const b = this.box(r)
          if (b.w > 0 && b.h > 0) this.push({ k: 'link', ...b, url: el.href }, ctx, b.y, b.y + b.h, false)
        }
      }

      const childCtx: Ctx = { ...ctx }
      if (
        (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') &&
        !ctx.transformed &&
        el !== this.section.el
      ) {
        const r = el.getBoundingClientRect()
        const bl = parseFloat(cs.borderLeftWidth) || 0
        const bt = parseFloat(cs.borderTopWidth) || 0
        childCtx.clip = intersect(ctx.clip, {
          x: r.left - this.ox + bl,
          y: r.top - this.oy + bt,
          w: el.clientWidth || r.width,
          h: el.clientHeight || r.height,
        })
      }
      for (const child of el.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) await this.walk(child as Element, childCtx)
        else if (child.nodeType === Node.TEXT_NODE && visible) await this.text(child as Text, cs, childCtx)
      }
    } finally {
      restoreTransform?.()
    }
  }

  private async paintBox(el: Element, cs: CSSStyleDeclaration, ctx: Ctx) {
    const bg = parseColor(cs.backgroundColor)
    const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).map((s) => {
      const w = parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) || 0
      const style = cs.getPropertyValue(`border-${s.toLowerCase()}-style`)
      const color = parseColor(cs.getPropertyValue(`border-${s.toLowerCase()}-color`))
      return w > 0 && style !== 'none' && style !== 'hidden' && color && color.a > 0 ? { w, style, color } : null
    })
    if (!(bg && bg.a > 0) && !sides.some(Boolean)) return
    const inline = cs.display === 'inline'
    const rects = inline ? [...el.getClientRects()] : [el.getBoundingClientRect()]
    const radius = parseFloat(cs.borderTopLeftRadius) || 0
    const collapsed = cs.borderCollapse === 'collapse' && (el.tagName === 'TD' || el.tagName === 'TH')
    for (const r of rects) {
      const b = this.box(r)
      if (b.w <= 0 || b.h <= 0) continue
      if (bg && bg.a > 0) {
        this.push({ k: 'fill', ...b, color: bg.c, a: bg.a * ctx.opacity, r: radius }, ctx, b.y, b.y + b.h, false)
      }
      sides.forEach((s, i) => {
        if (!s) return
        const inset = collapsed ? 0 : s.w / 2
        const dash = s.style === 'dashed' ? [s.w * 3, s.w * 2] : s.style === 'dotted' ? [s.w, s.w] : undefined
        const seg =
          i === 0
            ? [b.x, b.y + inset, b.x + b.w, b.y + inset]
            : i === 1
              ? [b.x + b.w - inset, b.y, b.x + b.w - inset, b.y + b.h]
              : i === 2
                ? [b.x, b.y + b.h - inset, b.x + b.w, b.y + b.h - inset]
                : [b.x + inset, b.y, b.x + inset, b.y + b.h]
        this.push(
          { k: 'line', x1: seg[0], y1: seg[1], x2: seg[2], y2: seg[3], w: s.w, color: s.color.c, a: s.color.a * ctx.opacity, dash },
          ctx,
          Math.min(seg[1], seg[3]),
          Math.max(seg[1], seg[3]),
          false,
        )
      })
    }
  }

  private image(img: HTMLImageElement, ctx: Ctx) {
    if (!img.complete || !img.naturalWidth) return
    const b = this.box(img.getBoundingClientRect())
    if (b.w <= 0 || b.h <= 0) return
    this.push({ k: 'image', ...b, src: img.currentSrc || img.src, a: ctx.opacity }, ctx, b.y, b.y + b.h, true)
  }

  private async svg(svg: SVGSVGElement, ctx: Ctx) {
    const r = svg.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const b = this.box(r)
    const vb = svg.viewBox?.baseVal
    const vx = vb && vb.width ? vb.x : 0
    const vy = vb && vb.height ? vb.y : 0
    const sx = vb && vb.width ? r.width / vb.width : 1
    const sy = vb && vb.height ? r.height / vb.height : 1
    const vector = Math.abs(sx - sy) <= 0.01 * Math.max(sx, sy) ? this.svgPaths(svg) : null
    if (vector) {
      let top = Infinity
      let bottom = -Infinity
      for (const p of vector) {
        this.push(
          { k: 'path', x: b.x - vx * sx, y: b.y - vy * sy, scale: sx, ...p, fa: p.fa * ctx.opacity, sa: p.sa * ctx.opacity },
          ctx,
          b.y,
          b.y + b.h,
          true,
        )
        top = Math.min(top, b.y)
        bottom = Math.max(bottom, b.y + b.h)
      }
      return
    }
    // Anything fancier (gradients, text, filters): a sharp picture of it.
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      clone.setAttribute('width', String(r.width))
      clone.setAttribute('height', String(r.height))
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }))
      try {
        const img = await loadImage(url)
        const S = 3
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.ceil(r.width * S))
        c.height = Math.max(1, Math.ceil(r.height * S))
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
        this.push({ k: 'image', ...b, src: c.toDataURL('image/png'), a: ctx.opacity }, ctx, b.y, b.y + b.h, true)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch {
      /* leave it out */
    }
  }

  /** Plain SVG shapes → path data, or null when the drawing needs more than
   *  solid fills and strokes. */
  private svgPaths(svg: SVGSVGElement) {
    const out: Array<{ d: string; fill?: RGB; fa: number; stroke?: RGB; sa: number; sw: number; dash?: number[] }> = []
    const visit = (node: Element): boolean => {
      for (const child of node.children) {
        const tag = child.tagName.toLowerCase()
        const cs = getComputedStyle(child)
        if (cs.display === 'none') continue
        if (child.getAttribute('transform')) return false
        if (tag === 'g') {
          if (!visit(child)) return false
          continue
        }
        if (tag === 'title' || tag === 'desc' || tag === 'defs' || tag === 'metadata') continue
        let d = ''
        const n = (a: string) => parseFloat(child.getAttribute(a) || '0') || 0
        if (tag === 'path') d = child.getAttribute('d') || ''
        else if (tag === 'rect') {
          const [x, y, w, h, rx] = [n('x'), n('y'), n('width'), n('height'), n('rx') || n('ry')]
          if (w <= 0 || h <= 0) continue
          d = rx > 0 ? roundRectPath(w, h, rx).replace(/^M/, `M`) : `M${x} ${y}H${x + w}V${y + h}H${x}Z`
          if (rx > 0) {
            // shift the rounded rectangle to (x, y)
            const p = roundRectPath(w, h, rx)
            d = p.replace(/([MHVA])([^MHVAZ]*)/g, (_m, cmd: string, args: string) => {
              const v = args.trim().split(/[\s,]+/).map(parseFloat)
              if (cmd === 'M') return `M${v[0] + x} ${v[1] + y}`
              if (cmd === 'H') return `H${v[0] + x}`
              if (cmd === 'V') return `V${v[0] + y}`
              return `A${v[0]} ${v[1]} ${v[2]} ${v[3]} ${v[4]} ${v[5] + x} ${v[6] + y}`
            })
          }
        } else if (tag === 'circle' || tag === 'ellipse') {
          const cx = n('cx')
          const cy = n('cy')
          const rx = tag === 'circle' ? n('r') : n('rx')
          const ry = tag === 'circle' ? n('r') : n('ry')
          if (rx <= 0 || ry <= 0) continue
          d = `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`
        } else if (tag === 'line') d = `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`
        else if (tag === 'polyline' || tag === 'polygon') {
          const pts = (child.getAttribute('points') || '').trim().split(/[\s,]+/).map(parseFloat)
          if (pts.length < 4) continue
          d = `M${pts[0]} ${pts[1]}` + pts.slice(2).reduce((s, v, i) => s + (i % 2 ? ` ${v}` : `L${v}`), '') + (tag === 'polygon' ? 'Z' : '')
        } else return false
        if (!d) continue
        if (/url\(/.test(cs.fill) || /url\(/.test(cs.stroke)) return false
        const op = parseFloat(cs.opacity || '1')
        const fill = cs.fill === 'none' ? null : parseColor(cs.fill)
        const stroke = cs.stroke === 'none' ? null : parseColor(cs.stroke)
        const sw = parseFloat(cs.strokeWidth) || 0
        const dashes = cs.strokeDasharray && cs.strokeDasharray !== 'none' ? cs.strokeDasharray.split(/[\s,]+/).map(parseFloat).filter((x) => x > 0) : undefined
        if (!fill && !(stroke && sw > 0)) continue
        out.push({
          d,
          fill: fill && fill.a > 0 ? fill.c : undefined,
          fa: (fill?.a ?? 0) * parseFloat(cs.fillOpacity || '1') * op,
          stroke: stroke && stroke.a > 0 && sw > 0 ? stroke.c : undefined,
          sa: (stroke?.a ?? 0) * parseFloat(cs.strokeOpacity || '1') * op,
          sw,
          dash: dashes?.length ? dashes : undefined,
        })
      }
      return true
    }
    return visit(svg) ? out : null
  }

  private async text(node: Text, cs: CSSStyleDeclaration, ctx: Ctx) {
    const data = node.data
    if (!/\S/.test(data)) return
    const color = parseColor(cs.color)
    if (!color || color.a <= 0) return
    const size = parseFloat(cs.fontSize) || 12
    const family = mapFamily(cs.fontFamily)
    const bold = (parseInt(cs.fontWeight) || 400) >= 600
    const italic = cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique')
    const spacing = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0
    const ratio = this.baseline(cs)
    const css = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`

    // 1. Measure each word (a word wrapped over two lines is split per line).
    type Word = { s: number; e: number; x: number; y: number; w: number; h: number; rtl: boolean }
    const words: Word[] = []
    const re = /\S+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(data))) {
      const s = m.index
      const e = s + m[0].length
      this.range.setStart(node, s)
      this.range.setEnd(node, e)
      const rects = [...this.range.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
      if (!rects.length) continue
      const rtl = RTL.test(m[0])
      if (rects.length === 1) {
        const r = rects[0]
        words.push({ s, e, x: r.left, y: r.top, w: r.width, h: r.height, rtl })
        continue
      }
      // Split per character, grouped by line.
      let cur: Word | null = null
      for (let i = s; i < e; ) {
        const cp = data.codePointAt(i)!
        const n = cp > 0xffff ? 2 : 1
        this.range.setStart(node, i)
        this.range.setEnd(node, i + n)
        const r = [...this.range.getClientRects()].find((q) => q.width > 0 || q.height > 0)
        if (r) {
          if (cur && Math.abs(r.top - cur.y) < 1 && (rtl || r.left >= cur.x + cur.w - 1)) {
            if (rtl) {
              const right = Math.max(cur.x + cur.w, r.right)
              cur.x = Math.min(cur.x, r.left)
              cur.w = right - cur.x
            } else cur.w = r.right - cur.x
            cur.e = i + n
          } else {
            if (cur) words.push(cur)
            cur = { s: i, e: i + n, x: r.left, y: r.top, w: r.width, h: r.height, rtl }
          }
        }
        i += n
      }
      if (cur) words.push(cur)
    }
    if (!words.length) return

    // 2. Join neighbouring words separated by one ordinary space into runs.
    let spaceW = -1
    const runs: Word[] = []
    for (const w of words) {
      const last = runs.at(-1)
      // Right-to-left words on one line become one picture: the bidi order
      // inside it is then exactly the browser's.
      if (last && last.rtl && w.rtl && Math.abs(w.y - last.y) < 0.5 && /^\s+$/.test(data.slice(last.e, w.s))) {
        const right = Math.max(last.x + last.w, w.x + w.w)
        last.x = Math.min(last.x, w.x)
        last.w = right - last.x
        last.e = w.e
        continue
      }
      if (last && !last.rtl && !w.rtl && Math.abs(w.y - last.y) < 0.5 && Math.abs(w.h - last.h) < 0.5 && data.slice(last.e, w.s) === ' ') {
        if (spaceW < 0) {
          this.range.setStart(node, last.e)
          this.range.setEnd(node, w.s)
          spaceW = this.range.getBoundingClientRect().width
        }
        const gap = w.x - (last.x + last.w)
        if (Math.abs(gap - spaceW) < 0.35) {
          last.w = w.x + w.w - last.x
          last.e = w.e
          continue
        }
      }
      runs.push({ ...w })
    }

    // 3. Emit text (or pictures of text) per run.
    for (const run of runs) {
      const text = data.slice(run.s, run.e)
      const x = run.x - this.ox
      const y = run.y - this.oy
      const base = y + ratio * run.h
      if (run.rtl) {
        await this.raster(text, x, y, run.w, run.h, ratio, cs, ctx, true)
        continue
      }
      // Characters no bundled face covers are drawn as a picture.
      const cov = (ch: string) => isCovered(ch, family, bold, italic)
      if ([...text].every(cov)) {
        this.push(
          { k: 'text', x, base, size, text, family, bold, italic, color: color.c, a: color.a * ctx.opacity, width: run.w, spacing, css, h: run.h },
          ctx,
          y,
          y + run.h,
          true,
        )
        continue
      }
      // Mixed: split into covered / uncovered stretches, each measured.
      const pieces: Array<{ s: number; e: number; covered: boolean }> = []
      for (let i = 0; i < text.length; ) {
        const cp = text.codePointAt(i)!
        const n = cp > 0xffff ? 2 : 1
        const ch = text.slice(i, i + n)
        const covered = ch === ' ' ? (pieces.at(-1)?.covered ?? true) : cov(ch)
        const last = pieces.at(-1)
        if (last && last.covered === covered) last.e = i + n
        else pieces.push({ s: i, e: i + n, covered })
        i += n
      }
      for (const p of pieces) {
        const t = text.slice(p.s, p.e)
        if (!t.trim()) continue
        this.range.setStart(node, run.s + p.s)
        this.range.setEnd(node, run.s + p.e)
        const r = this.range.getBoundingClientRect()
        const px = r.left - this.ox
        if (p.covered) {
          this.push(
            { k: 'text', x: px, base, size, text: t, family, bold, italic, color: color.c, a: color.a * ctx.opacity, width: r.width, spacing, css, h: run.h },
            ctx,
            y,
            y + run.h,
            true,
          )
        } else await this.raster(t, px, y, r.width, run.h, ratio, cs, ctx, false)
      }
    }

    // 4. Underline / strike-through, one stroke per line.
    if (ctx.decor && (ctx.decor.u || ctx.decor.s)) {
      const lines = new Map<number, { x0: number; x1: number; y: number; h: number }>()
      for (const w of words) {
        const key = Math.round(w.y)
        const l = lines.get(key)
        if (l) {
          l.x0 = Math.min(l.x0, w.x)
          l.x1 = Math.max(l.x1, w.x + w.w)
        } else lines.set(key, { x0: w.x, x1: w.x + w.w, y: w.y, h: w.h })
      }
      const t = Math.max(0.5, size * 0.065)
      for (const l of lines.values()) {
        const base = l.y - this.oy + ratio * l.h
        const ys = [ctx.decor.u ? base + size * 0.11 : null, ctx.decor.s ? base - size * 0.28 : null]
        for (const yy of ys) {
          if (yy === null) continue
          this.push(
            { k: 'line', x1: l.x0 - this.ox, y1: yy, x2: l.x1 - this.ox, y2: yy, w: t, color: ctx.decor.color, a: ctx.opacity },
            ctx,
            yy - t,
            yy + t,
            false,
          )
        }
      }
    }
  }

  private async raster(text: string, x: number, y: number, w: number, h: number, ratio: number, cs: CSSStyleDeclaration, ctx: Ctx, rtl: boolean) {
    if (w <= 0 || h <= 0) return
    const S = 3
    const padX = h * 0.25
    const W = w + padX * 2
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.ceil(W * S))
    c.height = Math.max(1, Math.ceil(h * S))
    const g = c.getContext('2d')!
    g.scale(S, S)
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    if ('letterSpacing' in g && cs.letterSpacing !== 'normal') (g as unknown as { letterSpacing: string }).letterSpacing = cs.letterSpacing
    g.fillStyle = cs.color
    g.globalAlpha = ctx.opacity
    g.textBaseline = 'alphabetic'
    g.direction = cs.direction === 'rtl' ? 'rtl' : 'ltr'
    g.textAlign = 'left'
    g.fillText(text, padX, ratio * h)
    const png = await canvasPng(c)
    this.push({ k: 'raster', x: x - padX, y, w: W, h, png, text, rtl }, ctx, y, y + h, true)
  }
}

/** Splits a tall section into page bands [start, end) between lines. */
function paginate(c: Collector, bodyStart: number, pageBody: number): Array<[number, number]> {
  const body = c.items.filter((i) => i.group === 'body')
  let end = bodyStart
  for (const i of body) if (i.atomic || i.k === 'fill' || i.k === 'line') end = Math.max(end, i.bottom)
  const raw: Array<[number, number]> = []
  for (const i of body) if (i.atomic && i.bottom - i.top < pageBody) raw.push([i.top, i.bottom])
  for (const b of c.atomicBoxes) if (b[1] - b[0] < pageBody) raw.push(b)
  raw.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const r of raw) {
    const last = merged.at(-1)
    if (last && r[0] < last[1] - 0.5) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const bands: Array<[number, number]> = []
  let start = bodyStart
  let guard = 0
  while (end - start > pageBody + 0.5 && guard++ < 5000) {
    const limit = start + pageBody
    let br = limit
    const hit = merged.find((r) => r[0] < limit && r[1] > limit)
    if (hit && hit[0] > start + 1) br = hit[0]
    // Keep headings with the text that follows them.
    const before = merged.filter((r) => r[1] <= br + 0.5).at(-1)
    if (before) {
      const keep = c.keepBoxes.find((k) => k[0] <= before[0] + 0.5 && k[1] >= before[1] - 0.5)
      if (keep && keep[0] > start + pageBody * 0.25) br = keep[0]
    }
    bands.push([start, br])
    // The next page starts at the next line, not in the gap before it.
    const next = merged.find((r) => r[0] >= br - 0.5)
    start = next ? Math.max(br, Math.min(next[0], br + pageBody * 0.5)) : br
  }
  bands.push([start, Math.max(end, start)])
  return bands
}

const op = (name: string, ...args: Array<number | PDFName | PDFHexString>) =>
  PDFOperator.of(
    name as PDFOperatorNames,
    args.map((a) => (typeof a === 'number' ? PDFNumber.of(a) : a)),
  )

class Painter {
  private fonts: OfficeFontSet
  private images = new Map<string, Promise<PDFImage | null>>()
  private glyphless: PDFRef | null = null

  constructor(
    private doc: PDFDocument,
    private k: number,
  ) {
    this.fonts = new OfficeFontSet(doc)
  }

  private image(src: string): Promise<PDFImage | null> {
    let p = this.images.get(src)
    if (!p) {
      p = (async () => {
        try {
          const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer())
          if (bytes[0] === 0x89 && bytes[1] === 0x50) return await this.doc.embedPng(bytes)
          if (bytes[0] === 0xff && bytes[1] === 0xd8) return await this.doc.embedJpg(bytes)
          // gif, webp, bmp, svg…: through a canvas
          const img = await loadImage(src)
          const max = 2400
          const s = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
          const c = document.createElement('canvas')
          c.width = Math.max(1, Math.round((img.naturalWidth || 300) * s))
          c.height = Math.max(1, Math.round((img.naturalHeight || 150) * s))
          c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
          return await this.doc.embedPng(await canvasPng(c))
        } catch {
          return null
        }
      })()
      this.images.set(src, p)
    }
    return p
  }

  /** Paints the items onto a page. `dy` shifts section y to page y; `band`
   *  limits what shows (page y range), for content split over pages. */
  async paint(page: PDFPage, items: Item[], dy: number, pageH: number, band?: [number, number]) {
    const k = this.k
    const Ph = pageH * k
    const X = (x: number) => x * k
    const Y = (y: number) => Ph - (y + dy) * k
    const G: Mat = [k, 0, 0, -k, 0, Ph - dy * k]
    const Gi = inv(G)
    for (const it of items) {
      if (band && (it.bottom + dy < band[0] - 0.5 || it.top + dy > band[1] + 0.5)) continue
      const clip = it.clip
      const clipBand = band
      const pre: PDFOperator[] = []
      let depth = 0
      if (clip || clipBand) {
        let cx = -1e5
        let cy = -1e5
        let cw = 2e5
        let ch = 2e5
        if (clip) {
          cx = clip.x
          cy = clip.y + dy
          cw = clip.w
          ch = clip.h
        }
        if (clipBand) {
          const y0 = Math.max(cy, clipBand[0])
          const y1 = Math.min(cy + ch, clipBand[1])
          cy = y0
          ch = Math.max(0, y1 - y0)
        }
        if (cw <= 0 || ch <= 0) continue
        pre.push(pushGraphicsState(), rectangle(cx * k, Ph - (cy + ch) * k, cw * k, ch * k), clipOp(), endPath())
        depth++
      }
      if (it.m) {
        const C = mul(mul(G, it.m), Gi)
        pre.push(pushGraphicsState(), concatTransformationMatrix(...C))
        depth++
      }
      if (pre.length) page.pushOperators(...pre)
      try {
        await this.item(page, it, X, Y)
      } finally {
        if (depth) page.pushOperators(...Array.from({ length: depth }, () => popGraphicsState()))
      }
    }
  }

  private async item(page: PDFPage, it: Item, X: (x: number) => number, Y: (y: number) => number) {
    const k = this.k
    switch (it.k) {
      case 'fill': {
        if (it.r > 0.5) {
          page.drawSvgPath(roundRectPath(it.w, it.h, it.r), {
            x: X(it.x),
            y: Y(it.y),
            scale: k,
            color: rgb(...it.color),
            opacity: it.a,
          })
        } else
          page.drawRectangle({ x: X(it.x), y: Y(it.y + it.h), width: it.w * k, height: it.h * k, color: rgb(...it.color), opacity: it.a })
        return
      }
      case 'line':
        page.drawLine({
          start: { x: X(it.x1), y: Y(it.y1) },
          end: { x: X(it.x2), y: Y(it.y2) },
          thickness: it.w * k,
          color: rgb(...it.color),
          opacity: it.a,
          dashArray: it.dash?.map((d) => d * k),
        })
        return
      case 'path': {
        const opts: Parameters<PDFPage['drawSvgPath']>[1] = { x: X(it.x), y: Y(it.y), scale: it.scale * k }
        if (it.fill) {
          opts.color = rgb(...it.fill)
          opts.opacity = it.fa
        }
        if (it.stroke) {
          opts.borderColor = rgb(...it.stroke)
          opts.borderWidth = it.sw * it.scale * k
          opts.borderOpacity = it.sa
          if (it.dash) opts.borderDashArray = it.dash.map((d) => d * it.scale * k)
        }
        if (!it.fill && !it.stroke) return
        page.drawSvgPath(it.d, opts)
        return
      }
      case 'image': {
        const img = await this.image(it.src)
        if (img) page.drawImage(img, { x: X(it.x), y: Y(it.y + it.h), width: it.w * k, height: it.h * k, opacity: it.a })
        return
      }
      case 'raster': {
        const img = await this.doc.embedPng(it.png)
        page.drawImage(img, { x: X(it.x), y: Y(it.y + it.h), width: it.w * k, height: it.h * k })
        this.invisible(page, it.text, X(it.x + it.h * 0.25), Y(it.y + it.h * 0.85), (it.w - it.h * 0.5) * k, it.h * 0.8 * k, it.rtl)
        return
      }
      case 'link': {
        const ref = this.doc.context.register(
          this.doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [X(it.x), Y(it.y + it.h), X(it.x + it.w), Y(it.y)],
            Border: [0, 0, 0],
            A: { Type: 'Action', S: 'URI', URI: PDFString.of(it.url) },
          }),
        )
        page.node.addAnnot(ref)
        return
      }
      case 'text': {
        const parts = await this.fonts.split(it.text, it.family, it.bold, it.italic)
        // Positions inside the run come from the font's own advances; a tiny
        // horizontal scale absorbs any rounding against the browser's layout.
        let x = X(it.x)
        const size = it.size * k
        const sp = it.spacing * k
        let natural = 0
        for (const p of parts) {
          if (p.font) natural += p.font.widthOfTextAtSize(p.text, size) + sp * [...p.text].length
        }
        const target = it.width * k
        let sx = natural > 0 ? target / natural : 1
        if (!(sx > 0.75 && sx < 1.33) || [...it.text].length < 2) sx = 1
        const y = Y(it.base)
        const ops: PDFOperator[] = [pushGraphicsState()]
        if (Math.abs(sx - 1) > 0.002) ops.push(concatTransformationMatrix(sx, 0, 0, 1, x * (1 - sx), 0))
        if (sp) ops.push(setCharacterSpacing(sp))
        page.pushOperators(...ops)
        for (const p of parts) {
          const font: PDFFont | null = p.font
          if (font) {
            page.drawText(p.text, { x, y, size, font, color: rgb(...it.color), opacity: it.a })
            x += font.widthOfTextAtSize(p.text, size) + sp * [...p.text].length
          } else {
            // A character missing from the face (rare): draw it as a picture.
            const w = size * 0.6 * [...p.text].length
            x += w
          }
        }
        page.pushOperators(popGraphicsState())
        return
      }
    }
  }

  /** Searchable, invisible text over a picture of text. */
  private invisible(page: PDFPage, text: string, x: number, y: number, w: number, h: number, rtl: boolean) {
    const visual = rtl ? [...text].reverse().join('') : text
    const hex = utf16Hex(visual)
    if (!hex || w <= 0 || h <= 0) return
    if (!this.glyphless) this.glyphless = addGlyphlessFont(this.doc)
    const name = PDFName.of('FOfficeText')
    page.node.setFontDictionary(name, this.glyphless)
    const natural = (hex.length / 4) * 0.5 * h
    const tz = Math.max(1, Math.min(2000, (w / natural) * 100))
    page.pushOperators(
      op('q'),
      op('BT'),
      op('Tr', 3),
      op('Tf', name, h),
      op('Tz', tz),
      op('Tm', 1, 0, 0, 1, x, y),
      op('Tj', PDFHexString.of(hex)),
      op('ET'),
      op('Q'),
    )
  }
}

/**
 * Renders the sections into one PDF. Each section becomes one page, or
 * several when its content is taller than a page.
 */
export async function domToPdf(sections: FlowSection[], options: DomToPdfOptions = {}): Promise<Uint8Array> {
  const k = options.scale ?? 0.75
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  if (options.title) doc.setTitle(options.title)
  doc.setProducer('PDF Editor')
  doc.setCreator('PDF Editor (Office conversion)')
  const painter = new Painter(doc, k)

  for (const [si, section] of sections.entries()) {
    const report = async () => {
      options.onProgress?.((si + 0.5) / sections.length)
      await yieldToBrowser()
    }
    const c = new Collector(section, report)
    await c.run()
    const sectionH = Math.max(section.pageHeight, section.el.getBoundingClientRect().height)
    const W = section.pageWidth
    const H = section.pageHeight
    const header = c.items.filter((i) => i.group === 'header')
    const footer = c.items.filter((i) => i.group === 'footer')
    const body = c.items.filter((i) => i.group === 'body')

    if (sectionH <= H + 1) {
      const page = doc.addPage([W * k, H * k])
      await painter.paint(page, c.items, 0, H)
    } else {
      const pageBody = H - section.bodyTop - section.bodyBottom
      const bands = paginate(c, section.bodyTop, pageBody)
      for (const [j, [s, e]] of bands.entries()) {
        const page = doc.addPage([W * k, H * k])
        await painter.paint(page, header, 0, H)
        const dy = j === 0 ? 0 : section.bodyTop - s
        const top = j === 0 ? -1e6 : section.bodyTop
        const bottom = j === bands.length - 1 ? 1e6 : section.bodyTop + (e - s) + (j === 0 ? s - section.bodyTop : 0)
        await painter.paint(page, body, dy, H, [top, bottom])
        await painter.paint(page, footer, H - sectionH, H)
        await yieldToBrowser()
      }
    }
    options.onProgress?.((si + 1) / sections.length)
  }
  if (!doc.getPageCount()) doc.addPage()
  return doc.save()
}

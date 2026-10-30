import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFPage,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
} from 'pdf-lib'

/**
 * Carries comments and links (highlights, sticky notes, shapes, ink, typed
 * comments, URL and page links) from source pages onto exported pages.
 *
 * The exporter re-embeds each page's *content* as a form XObject, which on its
 * own drops everything in the page's /Annots array. Here those annotations are
 * copied across, their geometry is moved through the same transform the page
 * content went through (crop offset and any rotation), and links that jump to
 * another page are re-pointed at that page's place in the new document — or
 * dropped if that page was deleted.
 */

type Point = [number, number]
/** Maps a point from the source page's user space to the exported page. */
export type PageTransform = (x: number, y: number) => Point

const N = (s: string) => PDFName.of(s)

/** Annotation types this carries. Widgets (form fields) are flattened instead. */
const SKIP = new Set(['Widget', 'Screen', 'Movie', 'Sound', '3D', 'RichMedia'])
/** Actions safe to keep. JavaScript, Launch and friends are dropped. */
const SAFE_ACTIONS = new Set(['URI', 'GoTo', 'GoToR', 'Named'])

interface PendingLink {
  annot: PDFDict
  srcDoc: PDFDocument
  target: PDFRef
  /** the rest of the destination array after the page, e.g. /XYZ 72 700 0 */
  rest: PDFObject[]
  /** true if the destination lived in /A (GoTo action) rather than /Dest */
  inAction: boolean
}

function multiply(m1: number[], m2: number[]): number[] {
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

function numbers(arr: PDFArray | undefined): number[] | null {
  if (!arr) return null
  const out: number[] = []
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.lookup(i)
    if (!(v instanceof PDFNumber)) return null
    out.push(v.asNumber())
  }
  return out
}

function nameOf(v: PDFObject | undefined): string | null {
  return v instanceof PDFName ? v.decodeText() : null
}

function stringOf(v: PDFObject | undefined): string | null {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText()
  if (v instanceof PDFName) return v.decodeText()
  return null
}

/** Looks a named destination up in /Dests (PDF 1.1) or the /Names tree. */
function resolveNamedDest(doc: PDFDocument, name: string): PDFArray | null {
  const catalog = doc.catalog
  const fromValue = (v: PDFObject | undefined): PDFArray | null => {
    const r = v instanceof PDFRef ? doc.context.lookup(v) : v
    if (r instanceof PDFArray) return r
    if (r instanceof PDFDict) {
      const d = r.lookup(N('D'))
      return d instanceof PDFArray ? d : null
    }
    return null
  }
  const dests = catalog.lookup(N('Dests'))
  if (dests instanceof PDFDict) {
    const hit = fromValue(dests.get(N(name)))
    if (hit) return hit
  }
  const names = catalog.lookup(N('Names'))
  const tree = names instanceof PDFDict ? names.lookup(N('Dests')) : undefined
  const walk = (node: PDFObject | undefined, depth: number): PDFArray | null => {
    if (!(node instanceof PDFDict) || depth > 32) return null
    const leaf = node.lookup(N('Names'))
    if (leaf instanceof PDFArray) {
      for (let i = 0; i + 1 < leaf.size(); i += 2) {
        if (stringOf(leaf.lookup(i)) === name) return fromValue(leaf.get(i + 1))
      }
    }
    const kids = node.lookup(N('Kids'))
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const hit = walk(kids.lookup(i), depth + 1)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(tree, 0)
}

/** Explicit destination array → [pageRef, rest], or null. */
function destParts(doc: PDFDocument, dest: PDFObject | undefined): { target: PDFRef; rest: PDFObject[] } | null {
  let arr: PDFArray | null = null
  const resolved = dest instanceof PDFRef ? doc.context.lookup(dest) : dest
  if (resolved instanceof PDFArray) arr = resolved
  else {
    const name = stringOf(resolved)
    if (name) arr = resolveNamedDest(doc, name)
  }
  if (!arr || arr.size() < 1) return null
  const first = arr.get(0)
  if (!(first instanceof PDFRef)) return null
  const rest: PDFObject[] = []
  for (let i = 1; i < arr.size(); i++) rest.push(arr.get(i))
  return { target: first, rest }
}

export class AnnotationCarrier {
  private pending: PendingLink[] = []
  /** first exported page for each source page, per source document */
  private targets = new Map<PDFDocument, Map<string, { page: PDFPage; fwd: PageTransform }>>()
  /**
   * Source annotations already detached from their page, with the page-jump
   * found on each (null = none, 'skip' = a link whose target can't be found).
   * Kept so a duplicated page gets the same treatment the second time.
   */
  private prepared = new Map<PDFDict, { target: PDFRef; rest: PDFObject[]; inAction: boolean } | null | 'skip'>()

  constructor(private out: PDFDocument) {}

  /** Records where a source page landed, so links to it can be resolved. */
  registerTarget(srcDoc: PDFDocument, srcPageRef: PDFRef, page: PDFPage, fwd: PageTransform) {
    let m = this.targets.get(srcDoc)
    if (!m) this.targets.set(srcDoc, (m = new Map()))
    if (!m.has(srcPageRef.tag)) m.set(srcPageRef.tag, { page, fwd })
  }

  /** Copies the source page's annotations onto `outPage`. Returns how many. */
  copyPage(srcDoc: PDFDocument, srcPageIndex: number, outPage: PDFPage, fwd: PageTransform, angleCcw: number) {
    const srcPage = srcDoc.getPage(srcPageIndex)
    const annots = srcPage.node.Annots()
    if (!annots || !annots.size()) return 0
    // A fresh copier per exported page: a duplicated page gets its own
    // annotation objects rather than sharing them with the original.
    const copier = PDFObjectCopier.for(srcDoc.context, this.out.context)
    const ctx = this.out.context
    const rad = (angleCcw * Math.PI) / 180
    const cos = Math.round(Math.cos(rad) * 1e6) / 1e6
    const sin = Math.round(Math.sin(rad) * 1e6) / 1e6
    const rotation = [cos, sin, -sin, cos, 0, 0]

    let outAnnots = outPage.node.Annots()
    let copied = 0

    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i)
      const dict = entry instanceof PDFRef ? srcDoc.context.lookup(entry) : entry
      if (!(dict instanceof PDFDict)) continue
      const subtype = nameOf(dict.lookup(N('Subtype')))
      if (!subtype || SKIP.has(subtype)) continue

      // Detach everything that would drag other pages (or the whole source
      // document) into the copy: the /P back-pointer, page-jump destinations
      // (resolved separately below), optional-content and structure links.
      if (!this.prepared.has(dict)) this.prepared.set(dict, this.detach(srcDoc, dict, subtype))
      const prep = this.prepared.get(dict)
      if (prep === 'skip') continue
      const link = prep ?? null

      const newRef =
        entry instanceof PDFRef
          ? (copier.copy(entry) as PDFRef)
          : ctx.register(copier.copy(dict) as PDFDict)
      const copy = ctx.lookup(newRef)
      if (!(copy instanceof PDFDict)) continue

      // Move the geometry with the page content.
      const rect = numbers(copy.lookup(N('Rect')) as PDFArray | undefined)
      if (rect) {
        const pts = [fwd(rect[0], rect[1]), fwd(rect[2], rect[3]), fwd(rect[0], rect[3]), fwd(rect[2], rect[1])]
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        copy.set(N('Rect'), ctx.obj([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]))
      }
      for (const key of ['QuadPoints', 'Vertices', 'L', 'CL']) {
        const arr = numbers(copy.lookup(N(key)) as PDFArray | undefined)
        if (!arr) continue
        const moved: number[] = []
        for (let k = 0; k + 1 < arr.length; k += 2) moved.push(...fwd(arr[k], arr[k + 1]))
        copy.set(N(key), ctx.obj(moved))
      }
      const ink = copy.lookup(N('InkList'))
      if (ink instanceof PDFArray) {
        const strokes: number[][] = []
        for (let s = 0; s < ink.size(); s++) {
          const arr = numbers(ink.lookup(s) as PDFArray)
          if (!arr) continue
          const moved: number[] = []
          for (let k = 0; k + 1 < arr.length; k += 2) moved.push(...fwd(arr[k], arr[k + 1]))
          strokes.push(moved)
        }
        copy.set(N('InkList'), ctx.obj(strokes))
      }
      // A rotated page needs its appearances rotated too: the viewer maps the
      // appearance's (Matrix-transformed) BBox onto the new, rotated Rect.
      if (angleCcw % 360 !== 0) {
        const ap = copy.lookup(N('AP'))
        if (ap instanceof PDFDict) {
          for (const kind of ['N', 'R', 'D']) {
            const v = ap.lookup(N(kind))
            const streams: PDFStream[] = []
            if (v instanceof PDFStream) streams.push(v)
            else if (v instanceof PDFDict) {
              for (const [, s] of v.entries()) {
                const st = s instanceof PDFRef ? ctx.lookup(s) : s
                if (st instanceof PDFStream) streams.push(st)
              }
            }
            for (const st of streams) {
              const m = numbers(st.dict.lookup(N('Matrix')) as PDFArray | undefined) ?? [1, 0, 0, 1, 0, 0]
              st.dict.set(N('Matrix'), ctx.obj(multiply(m, rotation)))
            }
          }
        }
      }
      copy.set(N('P'), outPage.ref)

      if (link) this.pending.push({ annot: copy, srcDoc, ...link })

      if (!outAnnots) {
        outAnnots = ctx.obj([])
        outPage.node.set(N('Annots'), outAnnots)
      }
      outAnnots.push(newRef)
      copied++
    }
    return copied
  }

  /** Strips links back into the source document; returns any page jump. */
  private detach(srcDoc: PDFDocument, dict: PDFDict, subtype: string) {
    let link: { target: PDFRef; rest: PDFObject[]; inAction: boolean } | null = null
    dict.delete(N('P'))
    dict.delete(N('OC'))
    dict.delete(N('StructParent'))
    const dest = dict.get(N('Dest'))
    if (dest) {
      const parts = destParts(srcDoc, dest)
      dict.delete(N('Dest'))
      if (parts) link = { ...parts, inAction: false }
      else if (subtype === 'Link') return 'skip'
    }
    const action = dict.lookup(N('A'))
    if (action instanceof PDFDict) {
      action.delete(N('Next'))
      const s = nameOf(action.lookup(N('S')))
      if (!s || !SAFE_ACTIONS.has(s)) {
        dict.delete(N('A'))
        if (subtype === 'Link') return 'skip'
      } else if (s === 'GoTo') {
        const parts = destParts(srcDoc, action.get(N('D')))
        dict.delete(N('A'))
        if (parts) link = { ...parts, inAction: true }
        else if (subtype === 'Link') return 'skip'
      }
    }
    dict.delete(N('AA')) // additional (often scripted) actions
    return link
  }

  /** Points page-jump links at their pages in the new document. */
  finish() {
    const ctx = this.out.context
    for (const p of this.pending) {
      const hit = this.targets.get(p.srcDoc)?.get(p.target.tag)
      if (!hit) {
        // The page it pointed to isn't in this document any more. A dead link
        // is worse than none, so it goes (a comment keeps its note, though).
        if (nameOf(p.annot.lookup(N('Subtype'))) === 'Link') this.removeFromPage(p.annot)
        continue
      }
      const rest = [...p.rest]
      const kind = nameOf(rest[0])
      // /XYZ left top zoom: move the target point with that page's transform.
      if (kind === 'XYZ' && rest.length >= 3) {
        const left = rest[1] instanceof PDFNumber ? rest[1].asNumber() : null
        const top = rest[2] instanceof PDFNumber ? rest[2].asNumber() : null
        if (left !== null && top !== null) {
          const [x, y] = hit.fwd(left, top)
          rest[1] = PDFNumber.of(x)
          rest[2] = PDFNumber.of(y)
        }
      } else if (kind !== 'Fit' && kind !== 'XYZ') {
        rest.splice(0, rest.length, N('Fit'))
      }
      const dest = ctx.obj([hit.page.ref, ...rest])
      if (p.inAction) p.annot.set(N('A'), ctx.obj({ S: 'GoTo', D: dest }))
      else p.annot.set(N('Dest'), dest)
    }
    this.pending = []
  }

  private removeFromPage(annot: PDFDict) {
    const pageRef = annot.get(N('P'))
    const page = pageRef instanceof PDFRef ? this.out.context.lookup(pageRef) : null
    if (!(page instanceof PDFDict)) return
    const arr = page.lookup(N('Annots'))
    if (!(arr instanceof PDFArray)) return
    for (let i = arr.size() - 1; i >= 0; i--) {
      if (arr.lookup(i) === annot) arr.remove(i)
    }
  }
}

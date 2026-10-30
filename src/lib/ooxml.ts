/** Small helpers for reading Office Open XML packages (zip of XML parts). */
import { strFromU8 } from 'fflate'

export type Files = Record<string, Uint8Array>

export function xml(files: Files, path: string): Document | null {
  const f = files[path]
  if (!f) return null
  return new DOMParser().parseFromString(strFromU8(f), 'application/xml')
}
/** Children by local name (namespace-agnostic). */
export function kids(el: Element | Document | null | undefined, name: string): Element[] {
  if (!el) return []
  const out: Element[] = []
  const parent = el instanceof Document ? el.documentElement : el
  for (const c of parent.children) if (c.localName === name) out.push(c)
  return out
}
export const kid = (el: Element | Document | null | undefined, name: string) => kids(el, name)[0] ?? null
export function all(el: Element | Document | null | undefined, name: string): Element[] {
  if (!el) return []
  return [...el.getElementsByTagNameNS('*', name)]
}
export function rels(files: Files, partPath: string): Map<string, string> {
  const dir = partPath.slice(0, partPath.lastIndexOf('/') + 1)
  const relPath = `${dir}_rels/${partPath.slice(dir.length)}.rels`
  const doc = xml(files, relPath)
  const map = new Map<string, string>()
  for (const r of all(doc, 'Relationship')) {
    const target = r.getAttribute('Target') ?? ''
    if (r.getAttribute('TargetMode') === 'External') continue
    map.set(r.getAttribute('Id') ?? '', resolvePath(dir, target))
  }
  return map
}
export function resolvePath(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = (dir + target).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.' && p !== '') out.push(p)
  }
  return out.join('/')
}

/** External targets (hyperlinks) of a part's relationships. */
export function externalRels(files: Files, partPath: string): Map<string, string> {
  const dir = partPath.slice(0, partPath.lastIndexOf('/') + 1)
  const doc = xml(files, `${dir}_rels/${partPath.slice(dir.length)}.rels`)
  const map = new Map<string, string>()
  for (const r of all(doc, 'Relationship')) {
    if (r.getAttribute('TargetMode') === 'External') map.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '')
  }
  return map
}

export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
/** r:id / r:embed style attribute. */
export const rAttr = (el: Element | null | undefined, name: string) => el?.getAttributeNS(R_NS, name) ?? el?.getAttribute(`r:${name}`) ?? null

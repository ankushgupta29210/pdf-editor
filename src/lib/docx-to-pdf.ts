/**
 * Word (.docx) → PDF. docx-preview lays the document out as HTML (styles,
 * lists, tables, pictures, headers and footers); its sections are then split
 * into pages between lines and drawn as a real PDF by dom-to-pdf.
 */
import { renderAsync } from 'docx-preview'
import { domToPdf, type FlowSection } from './dom-to-pdf'
import { makeHost, materializeBefore, remapFonts, settle, type OfficeResult } from './office-common'
import { mapFamily, type FamilyKey } from './office-fonts'
import { unzipSync } from 'fflate'
import { all, kid, xml } from './ooxml'

/** Paragraph style ids with a given property (following basedOn chains). */
function stylesWith(stylesDoc: Document | null, prop: string): Set<string> {
  const byId = new Map<string, Element>()
  for (const st of all(stylesDoc, 'style')) if (st.getAttribute('w:type') === 'paragraph') byId.set(st.getAttribute('w:styleId') ?? '', st)
  const out = new Set<string>()
  for (const id of byId.keys()) {
    let cur = byId.get(id)
    for (let guard = 0; cur && guard < 20; guard++) {
      const el = kid(kid(cur, 'pPr'), prop)
      if (el) {
        if (el.getAttribute('w:val') !== '0' && el.getAttribute('w:val') !== 'false') out.add(id)
        break
      }
      cur = byId.get(kid(cur, 'basedOn')?.getAttribute('w:val') ?? '')
    }
  }
  return out
}
const styleClass = (id: string) => 'docx_' + id.replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase()

/** Word drops the space between paragraphs of the same style when that style
 *  has "Don't add space between paragraphs of the same style" (lists, mostly). */
function contextualSpacing(host: HTMLElement, ids: Set<string>) {
  for (const id of ids) {
    const cls = styleClass(id)
    for (const p of host.querySelectorAll<HTMLElement>(`p.${CSS.escape(cls)}`)) {
      const next = p.nextElementSibling
      if (next instanceof HTMLElement && next.tagName === 'P' && next.classList.contains(cls)) {
        p.style.marginBottom = '0'
        next.style.marginTop = '0'
      }
    }
  }
}

/** A font's "single" line height as a multiple of its size (Word uses the
 *  font's own metrics; these are Calibri, Cambria, Arial, Times, Courier). */
const SINGLE: Record<FamilyKey, number> = { calibri: 1.2207, cambria: 1.1719, sans: 1.149, serif: 1.149, mono: 1.133 }

/**
 * Word's "1.15 lines" means 1.15 × the font's single line height, but
 * docx-preview writes it as CSS `line-height: 1.15` (× the font size), which
 * packs text tighter than Word does — documents came out with fewer pages.
 * Unitless line heights are rescaled by each paragraph's font.
 */
function fixLineSpacing(host: HTMLElement) {
  const re = /line-height:\s*([\d.]+)\s*(;|\}|$)/g
  const fix = (css: string) => css.replace(re, (_m, n: string, end: string) => `line-height: calc(var(--pe-lh, 1.15) * ${n})${end}`)
  for (const st of host.querySelectorAll('style')) st.textContent = fix(st.textContent ?? '')
  for (const el of host.querySelectorAll<HTMLElement>('[style*="line-height"]')) {
    const v = el.style.lineHeight
    if (/^[\d.]+$/.test(v)) el.style.lineHeight = `calc(var(--pe-lh, 1.15) * ${v})`
  }
  for (const p of host.querySelectorAll<HTMLElement>('p, li')) {
    const first = [...p.querySelectorAll('span')].find((x) => x.textContent?.trim()) ?? p
    p.style.setProperty('--pe-lh', String(SINGLE[mapFamily(getComputedStyle(first).fontFamily)]))
  }
}

export async function docxToPdf(
  data: ArrayBuffer,
  opts: { title?: string; onProgress?: (f: number) => void } = {},
): Promise<OfficeResult> {
  const host = makeHost()
  const warnings: string[] = []
  let stylesDoc: Document | null = null
  try {
    stylesDoc = xml(unzipSync(new Uint8Array(data), { filter: (f) => f.name === 'word/styles.xml' }), 'word/styles.xml')
  } catch {
    /* docx-preview reports damaged files itself */
  }
  try {
    await renderAsync(data, host, host, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      renderChanges: false,
      useBase64URL: true,
      experimental: true,
      trimXmlDeclaration: true,
      debug: false,
    })
    opts.onProgress?.(0.15)
    const wrapper = host.querySelector<HTMLElement>('.docx-wrapper') ?? host
    // The preview chrome (grey backdrop, gaps, shadows) is not part of the page.
    wrapper.style.cssText += ';background:none;padding:0;gap:0'
    for (const s of host.querySelectorAll<HTMLElement>('section.docx')) {
      s.style.boxShadow = 'none'
      s.style.marginBottom = '0'
    }
    materializeBefore(host)
    remapFonts(host)
    fixLineSpacing(host)
    contextualSpacing(host, stylesWith(stylesDoc, 'contextualSpacing'))
    const keepNext = [...stylesWith(stylesDoc, 'keepNext')].map((id) => `article p.${CSS.escape(styleClass(id))}`)
    await settle(host)
    if (host.querySelector('.docx [class*="chart"], .docx canvas')) warnings.push('charts')

    const sections: FlowSection[] = []
    for (const el of host.querySelectorAll<HTMLElement>('section.docx')) {
      const cs = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      const pageHeight = parseFloat(cs.minHeight) || rect.height
      sections.push({
        el,
        pageWidth: rect.width,
        pageHeight,
        bodyTop: parseFloat(cs.paddingTop) || 0,
        bodyBottom: parseFloat(cs.paddingBottom) || 0,
        header: [...el.querySelectorAll(':scope > header')],
        footer: [...el.querySelectorAll(':scope > footer')],
        keepWithNext: [...el.querySelectorAll(['article p[class*="heading"]', 'article p[class*="title"]', ...keepNext].join(','))],
      })
    }
    if (!sections.length) throw new Error('this Word file has no pages to convert')
    const bytes = await domToPdf(sections, {
      scale: 0.75,
      title: opts.title,
      onProgress: (f) => opts.onProgress?.(0.15 + f * 0.85),
    })
    return { bytes, warnings }
  } finally {
    host.remove()
  }
}

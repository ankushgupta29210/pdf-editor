import type { PageNumberSettings } from './types'

/** Text for a page-number stamp, or null if this page is not numbered. */
export function pageNumberText(s: PageNumberSettings, index: number, total: number): string | null {
  if (s.skipFirst && index === 0) return null
  const counted = s.skipFirst ? total - 1 : total
  const n = s.start + (s.skipFirst ? index - 1 : index)
  return s.format.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(counted + s.start - 1))
}

/**
 * Where a page-number stamp sits, in top-left display coordinates, for a text
 * run `textW` wide. Shared with the editor preview so both agree exactly.
 */
export function pageNumberBox(s: PageNumberSettings, pageW: number, pageH: number, textW: number) {
  const [v, hpos] = s.position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right']
  const x = hpos === 'left' ? s.margin : hpos === 'right' ? pageW - s.margin - textW : (pageW - textW) / 2
  const top = v === 'top' ? s.margin : pageH - s.margin - s.fontSize
  return { x, top }
}

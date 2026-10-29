/**
 * Parses page ranges like "1-3, 5, 8-" against a document of `total` pages.
 * Returns groups of 0-based indices (one group per comma-separated part), or
 * an error message a person can act on.
 */
export function parseRanges(input: string, total: number): number[][] | string {
  const parts = input
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return 'Enter at least one page or range, like 1-3, 5.'
  const groups: number[][] = []
  for (const part of parts) {
    let from: number
    let to: number
    if (/^\d+$/.test(part)) {
      from = to = Number(part)
    } else {
      // "2-6", "2 to 6", "-4" (from the start), "8-" (to the end)
      const m = /^(\d*)\s*(?:[-–—]|to)\s*(\d*)$/i.exec(part)
      if (!m || (!m[1] && !m[2])) return `“${part}” isn't a page or range. Use numbers like 4 or 2-6.`
      from = m[1] ? Number(m[1]) : 1
      to = m[2] ? Number(m[2]) : total
    }
    if (from < 1 || to < 1) return 'Page numbers start at 1.'
    if (from > total || to > total) return `This document has ${total} page${total === 1 ? '' : 's'} — “${part}” goes past the end.`
    if (from > to) return `“${part}” runs backwards. Write it low to high, like ${to}-${from}.`
    groups.push(Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i))
  }
  return groups
}

/** "1-3" / "5" label for a group of 0-based indices. */
export function rangeLabel(group: number[]): string {
  const a = group[0] + 1
  const b = group[group.length - 1] + 1
  return a === b ? String(a) : `${a}-${b}`
}

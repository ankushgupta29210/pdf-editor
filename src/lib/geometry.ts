import type { PageItem } from './types'

export interface Size { w: number; h: number }

/** Size of the page as it is shown to the user, after the user's own rotation. */
export function displaySize(p: Pick<PageItem, 'rotate' | 'baseWidth' | 'baseHeight'>): Size {
  return p.rotate % 180 === 90
    ? { w: p.baseHeight, h: p.baseWidth }
    : { w: p.baseWidth, h: p.baseHeight }
}

/**
 * A clockwise UI rotation expressed as the counter-clockwise angle PDF uses,
 * together with the translation that brings the rotated box back into the
 * positive quadrant. `w`/`h` are the box dimensions *before* rotating.
 */
export function rotationPlacement(rotateCw: number, w: number, h: number) {
  const ccw = ((360 - (rotateCw % 360)) % 360) as 0 | 90 | 180 | 270
  switch (ccw) {
    case 90:
      return { ccw, tx: h, ty: 0 }
    case 180:
      return { ccw, tx: w, ty: h }
    case 270:
      return { ccw, tx: 0, ty: w }
    default:
      return { ccw, tx: 0, ty: 0 }
  }
}

/** CSS transform that rotates the annotation layer along with the page image. */
export function layerTransform(rotateCw: number, baseW: number, baseH: number): string {
  switch (rotateCw % 360) {
    case 90:
      return `translate(${baseH}px, 0px) rotate(90deg)`
    case 180:
      return `translate(${baseW}px, ${baseH}px) rotate(180deg)`
    case 270:
      return `translate(0px, ${baseW}px) rotate(270deg)`
    default:
      return 'none'
  }
}

/** Map a point from displayed page space back into unrotated base space. */
export function toBaseSpace(
  rotateCw: number,
  baseW: number,
  baseH: number,
  dx: number,
  dy: number,
): { x: number; y: number } {
  switch (rotateCw % 360) {
    case 90:
      return { x: dy, y: baseH - dx }
    case 180:
      return { x: baseW - dx, y: baseH - dy }
    case 270:
      return { x: baseW - dy, y: dx }
    default:
      return { x: dx, y: dy }
  }
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim())
  if (!m) return { r: 0, g: 0, b: 0 }
  let s = m[1]
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

import type { PDFDocumentProxy } from './pdfjs'

export interface SourceDoc {
  id: string
  name: string
  bytes: Uint8Array
  proxy: PDFDocumentProxy
  pageCount: number
  /** false when pdf-lib cannot parse this file, so its pages export as images */
  vectorOk: boolean
}

/** One page in the working document. Sizes are display points (post-rotation). */
export interface PageItem {
  id: string
  srcId: string
  srcIndex: number
  /** extra clockwise rotation applied by the user, on top of the page's own /Rotate */
  rotate: 0 | 90 | 180 | 270
  /** unrotated display size in points (already includes the source page's own /Rotate) */
  baseWidth: number
  baseHeight: number
}

export type FontKey = 'Helvetica' | 'Times' | 'Courier'

interface AnnBase {
  id: string
  pageId: string
  /** top-left origin, in display points */
  x: number
  y: number
  w: number
  h: number
}

export interface TextAnn extends AnnBase {
  kind: 'text'
  text: string
  fontSize: number
  color: string
  font: FontKey
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  lineHeight: number
}

export interface ShapeAnn extends AnnBase {
  kind: 'rect' | 'ellipse' | 'line'
  stroke: string
  strokeWidth: number
  fill: string | null
  opacity: number
  /**
   * True for a box created with the whiteout/redact tool. Any page carrying one
   * of these is flattened to a flat image on export (see lib/export.ts) so the
   * text or graphics underneath are actually destroyed, not just painted over —
   * a plain white rectangle would otherwise leave the original content stream
   * intact and recoverable by copying the "hidden" text or re-extracting it.
   */
  redact?: boolean
}

export interface HighlightAnn extends AnnBase {
  kind: 'highlight'
  color: string
  opacity: number
}

export interface InkAnn extends AnnBase {
  kind: 'ink'
  /** points normalised 0..1 inside the annotation box, so resizing scales the stroke */
  strokes: Array<Array<[number, number]>>
  stroke: string
  strokeWidth: number
}

export interface ImageAnn extends AnnBase {
  kind: 'image'
  /** key into the image store */
  imageId: string
  opacity: number
}

export type Annotation = TextAnn | ShapeAnn | HighlightAnn | InkAnn | ImageAnn
export type Tool = 'select' | 'text' | 'rect' | 'ellipse' | 'line' | 'highlight' | 'ink' | 'whiteout' | 'image'

export interface StoredImage {
  id: string
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
  url: string
}

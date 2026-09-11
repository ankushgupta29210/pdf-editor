import type { PDFDocumentProxy } from './pdfjs'

/**
 * pdf.js rejects a render that is still running on the same page proxy, so each
 * caller gets a task it can cancel when React re-runs the effect.
 */
export interface RenderHandle {
  cancel: () => void
  done: Promise<void>
}

export function renderPageToCanvas(
  proxy: PDFDocumentProxy,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  opts: { scale: number; rotateCw?: number; background?: string },
): RenderHandle {
  let cancelled = false
  let task: { cancel(): void } | null = null

  const done = (async () => {
    const page = await proxy.getPage(pageIndex + 1)
    if (cancelled) return
    const rotation = (((page.rotate + (opts.rotateCw ?? 0)) % 360) + 360) % 360
    const viewport = page.getViewport({ scale: opts.scale, rotation })
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const render = page.render({
      canvasContext: ctx,
      viewport,
      background: opts.background ?? '#ffffff',
    })
    task = render
    try {
      await render.promise
    } catch (err) {
      // A cancelled render is expected whenever the user zooms or flips pages.
      if (!(err instanceof Error) || err.name !== 'RenderingCancelledException') throw err
    }
  })()

  return {
    cancel() {
      cancelled = true
      task?.cancel()
    },
    done: done.catch(() => undefined),
  }
}

export interface RasterResult {
  bytes: Uint8Array
  /** pixel size of the encoded image */
  width: number
  height: number
  /** the page's own size in points, before any extra rotation */
  pointWidth: number
  pointHeight: number
}

/**
 * Renders a page to a JPEG. Used both by the compressor and as the exporter's
 * fallback for pages pdf-lib refuses to copy as vector content.
 */
export async function renderPageToJpeg(
  proxy: PDFDocumentProxy,
  pageIndex: number,
  opts: {
    scale: number
    quality: number
    grayscale?: boolean
    rotateCw?: number
    /** reuse one canvas across a batch to keep peak memory down */
    canvas?: HTMLCanvasElement
    maxEdge?: number
  },
): Promise<RasterResult> {
  const page = await proxy.getPage(pageIndex + 1)
  const base = page.getViewport({ scale: 1 })
  // Keep canvases inside browser texture limits on very large pages.
  const cap = (opts.maxEdge ?? 5000) / Math.max(base.width, base.height)
  const rotation = (((page.rotate + (opts.rotateCw ?? 0)) % 360) + 360) % 360
  const viewport = page.getViewport({ scale: Math.max(Math.min(opts.scale, cap), 0.05), rotation })

  const canvas = opts.canvas ?? document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.')

  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise

  if (opts.grayscale) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = img.data
    for (let p = 0; p < d.length; p += 4) {
      const v = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0
      d[p] = v
      d[p + 1] = v
      d[p + 2] = v
    }
    ctx.putImageData(img, 0, 0)
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', opts.quality),
  )
  if (!blob) throw new Error(`Could not encode page ${pageIndex + 1} as an image.`)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  page.cleanup()
  return {
    bytes,
    width: canvas.width,
    height: canvas.height,
    pointWidth: base.width,
    pointHeight: base.height,
  }
}

const thumbs = new Map<string, string>()
/** Thumbnails are data URLs, so the cache is bounded to keep memory in check. */
const THUMB_CACHE_LIMIT = 240

/** Thumbnails are rendered unrotated once and re-used; rotation is applied in CSS. */
export async function getThumbnail(
  proxy: PDFDocumentProxy,
  srcId: string,
  pageIndex: number,
  targetWidth = 150,
): Promise<string> {
  const key = `${srcId}:${pageIndex}:${targetWidth}`
  const hit = thumbs.get(key)
  if (hit) return hit

  const page = await proxy.getPage(pageIndex + 1)
  const base = page.getViewport({ scale: 1 })
  const scale = (targetWidth * Math.min(window.devicePixelRatio || 1, 2)) / base.width
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is unavailable.')
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise
  const url = canvas.toDataURL('image/jpeg', 0.7)
  if (thumbs.size >= THUMB_CACHE_LIMIT) {
    for (const oldest of thumbs.keys()) {
      thumbs.delete(oldest)
      if (thumbs.size < THUMB_CACHE_LIMIT) break
    }
  }
  thumbs.set(key, url)
  page.cleanup()
  return url
}

export const FONT_STACKS: Record<string, string> = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
}

/** An image in a form pdf-lib can definitely embed. */
export interface RawImage {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

export type PageSizeId = 'fit' | 'a4' | 'letter' | 'legal' | 'a3' | 'a5'

/** Portrait dimensions in PDF points. */
export const PAGE_SIZES: Record<Exclude<PageSizeId, 'fit'>, { w: number; h: number }> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
  legal: { w: 612, h: 1008 },
  a3: { w: 841.89, h: 1190.55 },
  a5: { w: 419.53, h: 595.28 },
}

export const PAGE_SIZE_LABELS: Record<PageSizeId, string> = {
  fit: 'Fit page to image',
  a4: 'A4',
  letter: 'Letter',
  legal: 'Legal',
  a3: 'A3',
  a5: 'A5',
}

export interface ImagePageOptions {
  pageSize: PageSizeId
  orientation: 'auto' | 'portrait' | 'landscape'
  /** margin in points on all four sides */
  margin: number
  /** contain shows the whole image; cover fills the page and crops the overflow */
  fit: 'contain' | 'cover'
}

export const DEFAULT_IMAGE_OPTIONS: ImagePageOptions = {
  pageSize: 'a4',
  orientation: 'auto',
  margin: 24,
  fit: 'contain',
}

/** Browsers treat image pixels as CSS pixels at 96 DPI; PDF works in 72 DPI points. */
const PX_TO_PT = 72 / 96

const isPassthrough = (type: string): type is 'image/png' | 'image/jpeg' =>
  type === 'image/png' || type === 'image/jpeg'

async function loadBitmap(file: File): Promise<{ source: CanvasImageSource; w: number; h: number }> {
  // createImageBitmap covers webp, avif, gif, bmp and more, but not SVG in every
  // browser, so fall back to an <img> which does handle it.
  if (typeof createImageBitmap === 'function' && file.type !== 'image/svg+xml') {
    try {
      const bmp = await createImageBitmap(file)
      return { source: bmp, w: bmp.width, h: bmp.height }
    } catch {
      /* fall through to the <img> path */
    }
  }

  const url = URL.createObjectURL(file)
  try {
    const el = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`${file.name} is not an image this browser can read.`))
      img.src = url
    })
    // SVGs without intrinsic dimensions report 0; give them a usable canvas size.
    return {
      source: el,
      w: el.naturalWidth || 1024,
      h: el.naturalHeight || 1024,
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/**
 * Re-encodes any browser-decodable image as PNG or JPEG. pdf-lib only embeds
 * those two, and canvas output is always in a form it accepts — which also
 * rescues CMYK JPEGs and 16-bit or interlaced PNGs.
 */
export async function reencodeImage(file: File): Promise<RawImage> {
  const { source, w, h } = await loadBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.')
  ctx.drawImage(source, 0, 0, w, h)
  if ('close' in source && typeof source.close === 'function') source.close()

  // JPEG cannot carry transparency, so only reach for it when there is none.
  let hasAlpha = false
  if (file.type !== 'image/jpeg' && file.type !== 'image/bmp') {
    const data = ctx.getImageData(0, 0, w, h).data
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255) {
        hasAlpha = true
        break
      }
    }
  }

  const mime = hasAlpha ? 'image/png' : 'image/jpeg'
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mime, mime === 'image/jpeg' ? 0.92 : undefined),
  )
  canvas.width = 0
  canvas.height = 0
  if (!blob) throw new Error(`${file.name} could not be converted.`)
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime, width: w, height: h }
}

/**
 * Reads an image file for embedding, keeping the original bytes when they are
 * already PNG or JPEG so nothing is re-compressed needlessly.
 */
export async function decodeImageFile(file: File): Promise<RawImage> {
  if (isPassthrough(file.type)) {
    const { source, w, h } = await loadBitmap(file)
    if ('close' in source && typeof source.close === 'function') source.close()
    return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, width: w, height: h }
  }
  return reencodeImage(file)
}

function pageDimensions(img: RawImage, opts: ImagePageOptions) {
  // "Fit" takes its shape from the image, so orientation does not apply.
  if (opts.pageSize === 'fit') {
    return {
      w: img.width * PX_TO_PT + opts.margin * 2,
      h: img.height * PX_TO_PT + opts.margin * 2,
    }
  }
  const size = PAGE_SIZES[opts.pageSize]
  const landscape =
    opts.orientation === 'landscape' ||
    (opts.orientation === 'auto' && img.width > img.height)
  return landscape ? { w: size.h, h: size.w } : { w: size.w, h: size.h }
}

/** Builds a single-page PDF holding one image, laid out per `opts`. */
export async function imageToPdfPage(
  img: RawImage,
  opts: ImagePageOptions,
): Promise<Uint8Array> {
  const {
    PDFDocument,
    clip,
    closePath,
    endPath,
    lineTo,
    moveTo,
    popGraphicsState,
    pushGraphicsState,
  } = await import('pdf-lib')

  const doc = await PDFDocument.create()
  const embedded =
    img.mime === 'image/png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes)

  const { w: pw, h: ph } = pageDimensions(img, opts)
  const margin = Math.min(opts.margin, Math.min(pw, ph) / 2 - 1)
  const boxW = Math.max(pw - margin * 2, 1)
  const boxH = Math.max(ph - margin * 2, 1)

  const scale =
    opts.fit === 'cover'
      ? Math.max(boxW / embedded.width, boxH / embedded.height)
      : Math.min(boxW / embedded.width, boxH / embedded.height)
  const drawW = embedded.width * scale
  const drawH = embedded.height * scale

  const page = doc.addPage([pw, ph])
  const clipped = opts.fit === 'cover' && (drawW > boxW + 0.01 || drawH > boxH + 0.01)
  if (clipped) {
    page.pushOperators(
      pushGraphicsState(),
      moveTo(margin, margin),
      lineTo(margin + boxW, margin),
      lineTo(margin + boxW, margin + boxH),
      lineTo(margin, margin + boxH),
      closePath(),
      clip(),
      endPath(),
    )
  }
  page.drawImage(embedded, {
    x: margin + (boxW - drawW) / 2,
    y: margin + (boxH - drawH) / 2,
    width: drawW,
    height: drawH,
  })
  if (clipped) page.pushOperators(popGraphicsState())

  return doc.save({ useObjectStreams: true, updateFieldAppearances: false })
}

/** Reads an image file and turns it into a one-page PDF, retrying via canvas. */
export async function imageFileToPdfPage(
  file: File,
  opts: ImagePageOptions,
): Promise<Uint8Array> {
  const img = await decodeImageFile(file)
  try {
    return await imageToPdfPage(img, opts)
  } catch {
    // The original bytes were a format pdf-lib rejects; normalise and retry.
    return imageToPdfPage(await reencodeImage(file), opts)
  }
}

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif,image/bmp,image/svg+xml'

export function isImageFile(file: File): boolean {
  return (
    file.type.startsWith('image/') ||
    /\.(png|jpe?g|webp|avif|gif|bmp|svg)$/i.test(file.name)
  )
}

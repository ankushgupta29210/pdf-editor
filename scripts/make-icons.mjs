/**
 * Generates the PNG app icons from the same design as public/favicon.svg.
 * iOS home-screen icons and most Android install prompts will not accept SVG,
 * so these have to exist as real bitmaps. Re-run with `node scripts/make-icons.mjs`.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const BLUE = [76, 141, 255]
const PALE = [207, 224, 255]
const WHITE = [255, 255, 255]

/** Signed distance to a rounded rectangle centred on the origin. */
function roundRectSdf(x, y, half, r) {
  const qx = Math.abs(x) - (half - r)
  const qy = Math.abs(y) - (half - r)
  return (
    Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
  )
}

const PAGE = { x0: 0.28, y0: 0.2, x1: 0.72, y1: 0.8, fold: 0.16 }

/** Colour of the icon at normalised (u, v), or null where it is transparent. */
function iconPixel(u, v) {
  if (roundRectSdf(u - 0.5, v - 0.5, 0.5, 0.22) > 0) return null

  const { x0, y0, x1, y1, fold } = PAGE
  if (u < x0 || u > x1 || v < y0 || v > y1) return BLUE

  // Distance into the folded top-right corner, as fractions of the fold size.
  const a = (u - (x1 - fold)) / fold
  const b = (y0 + fold - v) / fold
  const inCorner = a > 0 && b > 0
  if (inCorner && a + b > 1) return BLUE // the cut-away corner
  if (inCorner) return PALE // the fold flap itself

  // Two lines of "text" on the page.
  const onLine = (y, xEnd) =>
    Math.abs(v - y) < 0.022 && u > x0 + 0.07 && u < xEnd
  if (onLine(0.53, x1 - 0.07) || onLine(0.64, x1 - 0.18)) return BLUE
  return WHITE
}

function render(size) {
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      // 2x2 supersampling keeps the rounded corners from looking ragged.
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const px = iconPixel((x + ox) / size, (y + oy) / size)
        if (px) {
          r += px[0]
          g += px[1]
          b += px[2]
          a += 255
        }
      }
      const i = row + 1 + x * 4
      raw[i] = a ? Math.round(r / (a / 255)) : 0
      raw[i + 1] = a ? Math.round(g / (a / 255)) : 0
      raw[i + 2] = a ? Math.round(b / (a / 255)) : 0
      raw[i + 3] = Math.round(a / 4)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [name, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
]) {
  writeFileSync(join(OUT, name), render(size))
  console.log(`wrote public/${name} (${size}x${size})`)
}

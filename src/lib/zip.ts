import { zipSync } from 'fflate'

/**
 * Bundles several output files into one .zip so the browser offers a single
 * download instead of a burst of prompts. PDFs and images are already
 * compressed, so they are stored rather than deflated again.
 */
export function makeZip(files: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
  const used = new Set<string>()
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {}
  for (const f of files) {
    let name = f.name
    for (let n = 2; used.has(name); n++) name = f.name.replace(/(\.[^.]+)?$/, `-${n}$1`)
    used.add(name)
    entries[name] = [f.bytes, { level: 0 }]
  }
  return zipSync(entries)
}

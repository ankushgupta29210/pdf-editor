import { formatBytes } from './geometry'

/**
 * Everything is held in memory, so these caps exist to fail with a clear
 * message instead of crashing the tab. Mobile browsers are given less room
 * because they are killed far more aggressively.
 */
export const isSmallDevice = () =>
  typeof matchMedia === 'function' && matchMedia('(max-width: 820px)').matches

export const maxFileBytes = () => (isSmallDevice() ? 25 : 80) * 1024 * 1024
export const maxTotalBytes = () => (isSmallDevice() ? 60 : 250) * 1024 * 1024
/** Above this, warn that the browser may struggle before the user commits. */
export const heavyTotalBytes = () => (isSmallDevice() ? 25 : 100) * 1024 * 1024

/**
 * `isSmallDevice` keys off viewport width, which is the right question for
 * layout and the wrong one for deciding whether a machine can do heavy work: a
 * desktop window dragged narrow is still a desktop. A phone or tablet is the
 * thing with a pointer that is coarse and cannot hover — no desktop reports
 * that, however small the window gets.
 */
export const isMobileBrowser = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(pointer: coarse)').matches &&
  matchMedia('(hover: none)').matches

/**
 * The shrink flow never opens the document in the editor — it walks one page at
 * a time straight into a new file — so it can take input far beyond the caps
 * above. The ceiling here is about how much a browser tab can hold at once, not
 * about how much work it is. Mobile stays low on purpose: phone browsers kill
 * the tab outright rather than reporting that they ran out of room.
 */
export const maxShrinkBytes = () => (isMobileBrowser() ? 60 : 700) * 1024 * 1024
/** Above this the job is long enough that the user deserves telling beforehand. */
export const heavyShrinkBytes = () => 80 * 1024 * 1024

export function shrinkTooLargeMessage(name: string, size: number): string {
  return isMobileBrowser()
    ? `${name} is ${formatBytes(size)}. A phone or tablet browser cannot hold a file this big — ` +
      'it will close the tab part-way through. Open this page on a laptop or desktop instead.'
    : `${name} is ${formatBytes(size)} — larger than the ${formatBytes(maxShrinkBytes())} a browser tab can work with.`
}

export function fileTooLargeMessage(name: string, size: number): string {
  return `${name} is ${formatBytes(size)} — the limit is ${formatBytes(maxFileBytes())} per file on this device.`
}

export function totalTooLargeMessage(): string {
  return `That would exceed ${formatBytes(maxTotalBytes())} of open files. Download what you have, or remove some pages first.`
}

/**
 * Hands control back to the browser so it can paint. Long jobs run on the main
 * thread, and without this the progress bar never moves.
 */
export const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0))

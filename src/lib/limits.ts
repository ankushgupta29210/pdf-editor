import { formatBytes } from './geometry'

/**
 * Everything is held in memory, so these caps exist to fail with a clear
 * message instead of crashing the tab. Mobile browsers are given less room
 * because they are killed far more aggressively.
 */
const isSmallDevice = () =>
  typeof matchMedia === 'function' && matchMedia('(max-width: 820px)').matches

export const maxFileBytes = () => (isSmallDevice() ? 25 : 80) * 1024 * 1024
export const maxTotalBytes = () => (isSmallDevice() ? 60 : 250) * 1024 * 1024
/** Above this, warn that the browser may struggle before the user commits. */
export const heavyTotalBytes = () => (isSmallDevice() ? 25 : 100) * 1024 * 1024

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

/**
 * crypto.randomUUID only exists in a secure context, so a page served over
 * plain HTTP (a LAN IP during testing, say) would otherwise break outright.
 */
export const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
